"""Dedicated HF Job entrypoint; not an admission service or scheduler.

Only a supplied user credential is accepted. Never use the Space's HF_TOKEN.
This module is intentionally not wired to the execution-disabled API.
"""

import base64
import json
import os
import re
import signal
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

from harbor.models.job.config import JobConfig
from huggingface_hub import HfApi


class RunnerError(Exception):
    """A safe, fixed diagnostic (never include provider exception text)."""


def _component(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", value):
        raise RunnerError("Invalid runner destination.")
    return value


def _check_artifacts(root: Path, token: str) -> None:
    """Fail closed on links/special files or a literal supplied-token leak.

    This is not a general-purpose secret detector. Evidence remains private.
    """
    needle = token.encode()
    for path in root.rglob("*"):
        if token in str(path.relative_to(root)):
            raise RunnerError("Credential detected; upload withheld.")
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise RunnerError("Unsafe artifact; upload withheld.")
        if not path.is_file():
            continue
        tail = b""
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                data = tail + chunk
                if needle in data:
                    raise RunnerError("Credential detected; upload withheld.")
                tail = data[-len(needle) :]


def _execute(command: list[str], env: dict[str, str], log: Path, seconds: int) -> int:
    """Forward graceful termination to Harbor, then bound local shutdown.

    Stopping this process group says nothing about remote Sandbox termination.
    """
    with (
        log.open("xb") as output,
        subprocess.Popen(
            command,
            env=env,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        ) as child,
    ):
        previous = signal.getsignal(signal.SIGTERM)

        def terminate(_signum: int, _frame: object) -> None:
            raise InterruptedError

        signal.signal(signal.SIGTERM, terminate)
        try:
            return child.wait(timeout=seconds)
        except (subprocess.TimeoutExpired, InterruptedError, KeyboardInterrupt):
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            with suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                with suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            return 124
        finally:
            signal.signal(signal.SIGTERM, previous)


def _runtime_seconds() -> int:
    try:
        seconds = int(os.environ.get("HARBOR_HF_RUNTIME_SECONDS", "0"))
    except ValueError:
        raise RunnerError("A positive runtime limit is required.") from None
    if seconds <= 0:
        raise RunnerError("A positive runtime limit is required.")
    return seconds


def run(config_path: Path, workspace: Path) -> int:
    """Execute one native Harbor job and upload its unchanged private evidence."""
    token = os.environ.get("HARBOR_HF_USER_TOKEN", "")
    if not token:
        raise RunnerError("A supplied user token is required.")
    owner = _component(os.environ.get("HARBOR_HF_OWNER", ""))
    bucket = _component(os.environ.get("HARBOR_HF_RESULTS_BUCKET", ""))
    run_id = _component(os.environ.get("HARBOR_HF_RUN_ID", ""))
    seconds = _runtime_seconds()
    source = config_path.read_text()
    decoded = json.loads(source)
    if token in source or token in json.dumps(decoded, ensure_ascii=False):
        raise RunnerError("Credentials must not appear in Harbor configuration.")
    # The pinned model ignores this deprecated field; reject rather than ignore.
    if "plugins" in decoded:
        raise RunnerError("Runner does not permit result-publication plugins.")
    # Public model validation only; Harbor CLI retains resolution and execution.
    JobConfig.model_validate_json(source)
    api = HfApi(token=token)
    if api.whoami()["name"] != owner:
        raise RunnerError("Supplied token does not match the approved owner.")
    bucket_id = f"{owner}/{bucket}"
    if not api.bucket_info(bucket_id).private:
        raise RunnerError("An existing private results Bucket is required.")
    # A fresh directory prevents accidental merging or uploading unrelated runs.
    workspace.mkdir(mode=0o700, parents=True, exist_ok=False)
    config = workspace / "input.json"
    config.write_text(source)
    config.chmod(0o600)
    artifacts = workspace / "artifacts"
    artifacts.mkdir(mode=0o700)
    environment = {
        name: os.environ[name]
        for name in ("PATH", "HOME", "SSL_CERT_FILE", "SSL_CERT_DIR")
        if name in os.environ
    }
    environment.update(HF_TOKEN=token, HF_INFERENCE_TOKEN=token, PYTHONUNBUFFERED="1")
    code = _execute(
        [
            "harbor",
            "run",
            "--config",
            str(config.resolve()),
            "--jobs-dir",
            str(artifacts.resolve()),
            "--job-name",
            run_id,
        ],
        environment,
        artifacts / "runner.log",
        seconds,
    )
    _check_artifacts(artifacts, token)
    # Recheck privacy before transfer; do not create Buckets or change visibility.
    if not api.bucket_info(bucket_id).private:
        raise RunnerError("Bucket is no longer private; upload withheld.")
    api.sync_bucket(
        str(artifacts),
        f"hf://buckets/{bucket_id}/runs/{run_id}",
        delete=False,
        quiet=True,
    )
    print("Private artifact upload completed. Remote Sandbox cleanup is unverified.")
    return code


def main() -> int:
    try:
        if encoded := os.environ.pop("HARBOR_HF_CONFIG_B64", None):
            config = Path("/input/config.json")
            config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with config.open("x") as handle:
                config.chmod(0o600)
                handle.write(base64.b64decode(encoded, validate=True).decode())
        return run(Path("/input/config.json"), Path("/data/run"))
    except RunnerError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # Provider and Harbor exceptions can contain credentials or private config.
        print(
            "Runner failed; private artifact upload is not confirmed.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())

"""Run locked Harbor trials and submit evidence through a worker capability."""

from __future__ import annotations

import base64
import codecs
import concurrent.futures
import copy
import json
import math
import os
import signal
import subprocess
import tarfile
import tempfile
import threading
from collections import deque
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any

from harbor.models.job.config import JobConfig
from harbor.models.job.lock import TrialLock

from harbor_hf_agents.support.control_sandbox_environment import _ControlClient, _digest
from harbor_hf_agents.support.provider_outcome import (
    ProviderPolicyError,
    TerminalProviderError,
    TransientProviderError,
)

_EVIDENCE_CHUNK_BYTES = 8 * 1024 * 1024
_LOG_READ_CHARS = 8 * 1024
_LOG_DRAIN_SECONDS = 5
_MAX_SENSITIVE_OUTPUT_CHARS = 4 * 1024
_MAX_STREAMED_OUTPUT_CHARS = 1_000_000
_MAX_RETAINED_OUTPUT_CHARS = 1_000_000
_SENSITIVE_OUTPUT_ENVIRONMENT = (
    "HARBOR_HF_WORKER_CAPABILITY",
    "HF_INFERENCE_TOKEN",
    "HF_TOKEN",
    "SBX_TOKEN",
)
_HARBOR_CHILD_ENVIRONMENT = frozenset(
    {
        "ALL_PROXY",
        "CURL_CA_BUNDLE",
        "HARBOR_HF_ACTION_ID",
        "HARBOR_HF_CAMPAIGN_ID",
        "HARBOR_HF_CONTROL_URL",
        "HARBOR_HF_TASK_IDS_JSON",
        "HARBOR_HF_WORKER_CAPABILITY",
        "HARBOR_HF_WORKER_REVISION",
        "HARBOR_HF_WORKER_ROLE",
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LD_LIBRARY_PATH",
        "NO_PROXY",
        "PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "REQUESTS_CA_BUNDLE",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "VIRTUAL_ENV",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
)
_POLICY_FAILURES = {
    "AgentAuthenticationError",
    "ApiUsageLimitError",
    "ModelNotFoundError",
}
_INFRASTRUCTURE_MARKERS = ("Sandbox", "Connection", "Network", "HTTP")


@dataclass(frozen=True)
class LockedTask:
    task_id: str
    source_task_id: str
    trial_index: int
    input_digest: str
    image: str
    timeout_seconds: int
    trial_lock: TrialLock


@dataclass(frozen=True)
class WorkerConfig:
    campaign_id: str
    action_id: str
    harbor_version: str
    worker_revision: str
    concurrency: int
    max_tasks_per_job: int
    input_price: int
    output_price: int
    job_config: dict[str, Any]
    tasks: tuple[LockedTask, ...]


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required control worker setting {name} is missing")
    return value


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _profile(lock: dict[str, Any], kind: str) -> dict[str, Any]:
    matches = [item for item in lock.get("profiles", []) if item.get("kind") == kind]
    if len(matches) != 1 or not isinstance(matches[0].get("spec"), dict):
        raise RuntimeError(f"campaign lock must contain one {kind} profile")
    return matches[0]["spec"]


def _read_lock(campaign_id: str) -> dict[str, Any]:
    client = _ControlClient(campaign_id, "lock-reader")
    return client.request(
        "GET",
        f"/api/v1/campaigns/{campaign_id}/lock",
        idempotency_key=f"control-worker-lock-{_required('HARBOR_HF_ACTION_ID')}",
        timeout=60.0,
    )


def _read_prepared_job(campaign_id: str) -> dict[str, Any]:
    return _ControlClient(campaign_id, "prepared-job").request(
        "GET",
        f"/api/v1/campaigns/{campaign_id}/prepared-job",
        idempotency_key=f"prepared-job-{_required('HARBOR_HF_ACTION_ID')}",
        timeout=60.0,
    )


def _read_prepared_trial(campaign_id: str, task_id: str) -> dict[str, Any]:
    return _ControlClient(campaign_id, task_id).request(
        "GET",
        f"/api/v1/campaigns/{campaign_id}/prepared-job/trials/{task_id}",
        idempotency_key=(
            f"prepared-trial-{_required('HARBOR_HF_ACTION_ID')}-{task_id}"
        ),
        timeout=60.0,
    )


def _assigned_task_ids() -> tuple[str, ...]:
    value = json.loads(_required("HARBOR_HF_TASK_IDS_JSON"))
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item for item in value)
        or len(set(value)) != len(value)
    ):
        raise RuntimeError("worker task assignment is invalid")
    return tuple(value)


def _bounded_assignments(deployment: dict[str, Any]) -> tuple[int, tuple[str, ...]]:
    maximum = int(deployment["worker_max_tasks_per_job"])
    assigned = _assigned_task_ids()
    if len(assigned) > maximum:
        raise RuntimeError("worker assignment exceeds its locked task limit")
    return maximum, assigned


def _locked_config(lock: dict[str, Any]) -> WorkerConfig:
    campaign_id = _required("HARBOR_HF_CAMPAIGN_ID")
    action_id = _required("HARBOR_HF_ACTION_ID")
    if lock.get("campaign_id") != campaign_id:
        raise RuntimeError("campaign lock identity does not match worker environment")
    deployment = _profile(lock, "deployment")
    if (
        deployment.get("route") != "hf_job"
        or deployment.get("preparation") != "required"
    ):
        raise RuntimeError("control worker requires a prepared HF Job deployment")
    prepared = _read_prepared_job(campaign_id)
    references = {
        item["task_id"]: item
        for item in prepared.get("trials", [])
        if isinstance(item, dict) and isinstance(item.get("task_id"), str)
    }
    campaign_tasks = {
        item["task_id"]: item
        for item in lock.get("tasks", [])
        if isinstance(item, dict) and isinstance(item.get("task_id"), str)
    }
    max_tasks_per_job, assigned = _bounded_assignments(deployment)
    if any(
        task_id not in references or task_id not in campaign_tasks
        for task_id in assigned
    ):
        raise RuntimeError("worker task assignment is outside the prepared job")
    tasks: list[LockedTask] = []
    for task_id in assigned:
        value = _read_prepared_trial(campaign_id, task_id)
        expected = campaign_tasks[task_id]
        if (
            value.get("record_id") != references[task_id].get("record_id")
            or value.get("input_digest") != expected.get("input_digest")
            or value.get("source_task_id") != expected.get("source_task_id")
            or value.get("trial_index") != expected.get("trial_index")
        ):
            raise RuntimeError("prepared trial does not match the campaign lock")
        harbor_lock = TrialLock.model_validate(value.get("trial_lock"))
        if harbor_lock.task.digest != value.get("input_digest"):
            raise RuntimeError("prepared Harbor task digest does not match")
        timeout = sum(
            int(value[name])
            for name in (
                "agent_timeout_seconds",
                "verifier_timeout_seconds",
                "environment_build_timeout_seconds",
                "agent_setup_timeout_seconds",
            )
        )
        tasks.append(
            LockedTask(
                task_id=task_id,
                source_task_id=str(value["source_task_id"]),
                trial_index=int(value["trial_index"]),
                input_digest=str(value["input_digest"]),
                image=str(value["image"]),
                timeout_seconds=timeout,
                trial_lock=harbor_lock,
            )
        )
    job_config = prepared.get("job_config")
    if not isinstance(job_config, dict):
        raise RuntimeError("prepared Harbor job config is invalid")
    return WorkerConfig(
        campaign_id=campaign_id,
        action_id=action_id,
        harbor_version=str(deployment["harbor_version"]),
        worker_revision=str(deployment["worker_revision"]),
        concurrency=int(deployment["worker_concurrency"]),
        max_tasks_per_job=max_tasks_per_job,
        input_price=int(deployment["input_price_microusd_per_million_tokens"]),
        output_price=int(deployment["output_price_microusd_per_million_tokens"]),
        job_config=copy.deepcopy(job_config),
        tasks=tuple(tasks),
    )


def _task_source(task: LockedTask) -> dict[str, Any]:
    """Build the Harbor run task without a dataset source label."""
    source = task.trial_lock.task
    if source.type == "package":
        return {
            "name": source.name,
            "ref": source.digest,
        }
    if source.type == "git":
        if not source.git_url or not source.git_commit_id or source.path is None:
            raise RuntimeError("prepared Git task lock is incomplete")
        path = Path(source.path)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError("prepared Git task path is not portable")
        return {
            "path": path.as_posix(),
            "git_url": source.git_url,
            "git_commit_id": source.git_commit_id,
        }
    raise RuntimeError("prepared local Harbor tasks are not portable")


def _job_config(config: WorkerConfig, task: LockedTask, root: Path) -> Path:
    lock = task.trial_lock
    if lock.skills or lock.extra_instructions or lock.extra_docker_compose:
        raise RuntimeError(
            "prepared skills, instructions, and compose overlays are unsupported"
        )
    verifier = lock.verifier.model_dump(mode="json")
    verifier.pop("environment_mode", None)
    agent = lock.agent.model_dump(mode="json")
    agent["skills"] = []
    value = copy.deepcopy(config.job_config)
    value.update(
        {
            "job_name": task.task_id,
            "jobs_dir": str(root / "jobs"),
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "retry": {"max_retries": 0},
            "datasets": [],
            "tasks": [_task_source(task)],
            "agents": [agent],
            "environment": lock.environment.model_dump(mode="json"),
            "verifier": verifier,
            "timeout_multiplier": lock.timeout_multiplier,
            "agent_timeout_multiplier": lock.agent_timeout_multiplier,
            "verifier_timeout_multiplier": lock.verifier_timeout_multiplier,
            "agent_setup_timeout_multiplier": lock.agent_setup_timeout_multiplier,
            "environment_build_timeout_multiplier": (
                lock.environment_build_timeout_multiplier
            ),
            "extra_instruction_paths": [],
        }
    )
    validated = JobConfig.model_validate(value)
    path = root / "configs" / f"{task.task_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(validated.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
    )
    return path


def _result_path(root: Path, task: LockedTask) -> Path | None:
    matches = list((root / "jobs" / task.task_id).glob("*/result.json"))
    return matches[0] if len(matches) == 1 else None


def _exception_outcome(  # noqa: C901 -- explicit terminal outcome map
    result: dict[str, Any] | None,
    stderr: str,
    *,
    timed_out: bool = False,
) -> tuple[str, bool]:
    if timed_out or "AgentTimeoutError" in stderr or "VerifierTimeoutError" in stderr:
        return "benchmark_timeout", False
    if result is None:
        if any(marker in stderr for marker in _POLICY_FAILURES):
            return "policy", False
        return "infrastructure", True
    exception = result.get("exception_info")
    if not exception:
        return "complete", False
    name = (
        str(exception.get("exception_type", "")) if isinstance(exception, dict) else ""
    )
    detail = (
        " ".join(
            str(exception.get(key, ""))
            for key in ("exception_message", "exception_traceback")
        )
        if isinstance(exception, dict)
        else ""
    )
    if name in {"AgentTimeoutError", "VerifierTimeoutError"}:
        return "benchmark_timeout", False
    if name == TransientProviderError.__name__:
        return "infrastructure", True
    if name == ProviderPolicyError.__name__:
        return "policy", False
    if name == TerminalProviderError.__name__:
        return "agent", False
    if "policy_rejected" in detail:
        return "policy", False
    if any(marker in f"{name} {detail}" for marker in _INFRASTRUCTURE_MARKERS):
        return "infrastructure", True
    if "Verifier" in name or "Reward" in name:
        return "verifier", False
    if "Refusal" in name:
        return "refusal", False
    return "agent", False


def _metrics(result: dict[str, Any] | None) -> tuple[dict[str, float], int]:
    if result is None:
        return {}, 0
    metrics: dict[str, float] = {}
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    for name, value in rewards.items():
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            metrics[name] = float(value)
    agent = result.get("agent_result") or {}
    input_tokens = int(agent.get("n_input_tokens") or 0)
    output_tokens = int(agent.get("n_output_tokens") or 0)
    metrics["input_tokens"] = float(input_tokens)
    metrics["output_tokens"] = float(output_tokens)
    return metrics, input_tokens + output_tokens


def _cost_microusd(config: WorkerConfig, result: dict[str, Any] | None) -> int:
    if result is None:
        return 0
    agent = result.get("agent_result") or {}
    input_tokens = int(agent.get("n_input_tokens") or 0)
    output_tokens = int(agent.get("n_output_tokens") or 0)
    return math.ceil(
        input_tokens * config.input_price / 1_000_000
        + output_tokens * config.output_price / 1_000_000
    )


def _archive_trial(
    root: Path, task: LockedTask, result_path: Path | None, stderr: str
) -> Path:
    evidence_root = root / "evidence" / task.task_id
    evidence_root.mkdir(parents=True, exist_ok=True)
    (evidence_root / "worker-stderr.txt").write_text(stderr[-1_000_000:])
    metadata = {
        "schema_version": "v1",
        "task_id": task.task_id,
        "source_task_id": task.source_task_id,
        "trial_index": task.trial_index,
        "input_digest": task.input_digest,
        "image": task.image,
        "result_present": result_path is not None,
    }
    (evidence_root / "worker.json").write_bytes(_canonical_json(metadata))
    archive = evidence_root / "trial.tar.gz"
    with tarfile.open(archive, "w:gz") as handle:
        handle.add(evidence_root / "worker.json", arcname="worker.json")
        handle.add(evidence_root / "worker-stderr.txt", arcname="worker-stderr.txt")
        if result_path:
            handle.add(result_path.parent, arcname="harbor-trial")
    return archive


def _upload_evidence(
    config: WorkerConfig,
    task: LockedTask,
    archive: Path,
) -> tuple[str, str]:
    client = _ControlClient(config.campaign_id, task.task_id)
    attempt_path = f"{client.prefix}/attempts"
    objects: list[dict[str, Any]] = []
    with archive.open("rb") as handle:
        index = 0
        while chunk := handle.read(_EVIDENCE_CHUNK_BYTES):
            digest = _digest(chunk)
            uploaded = client.request(
                "POST",
                attempt_path,
                body={
                    "operation": "upload_evidence",
                    "action_id": config.action_id,
                    "digest": digest,
                    "content_base64": base64.b64encode(chunk).decode(),
                },
                idempotency_key=(
                    f"evidence-{config.action_id}-{task.task_id}-{index:06d}"
                ),
                timeout=300.0,
            )
            objects.append(
                {
                    "path": uploaded["path"],
                    "digest": digest,
                    "size": len(chunk),
                }
            )
            index += 1
    index_bytes = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "harbor.trial.chunk-index",
            "campaign_id": config.campaign_id,
            "action_id": config.action_id,
            "task_id": task.task_id,
            "archive": "trial.tar.gz",
            "archive_size": archive.stat().st_size,
            "chunks": objects,
        }
    )
    index_digest = _digest(index_bytes)
    uploaded_index = client.request(
        "POST",
        attempt_path,
        body={
            "operation": "upload_evidence",
            "action_id": config.action_id,
            "digest": index_digest,
            "content_base64": base64.b64encode(index_bytes).decode(),
        },
        idempotency_key=f"evidence-index-{config.action_id}-{task.task_id}",
        timeout=120.0,
    )
    objects.append(
        {
            "path": uploaded_index["path"],
            "digest": index_digest,
            "size": len(index_bytes),
        }
    )
    manifest_bytes = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "worker.evidence.manifest",
            "campaign_id": config.campaign_id,
            "action_id": config.action_id,
            "task_id": task.task_id,
            "objects": objects,
        }
    )
    manifest_digest = _digest(manifest_bytes)
    uploaded_manifest = client.request(
        "POST",
        attempt_path,
        body={
            "operation": "upload_evidence",
            "action_id": config.action_id,
            "digest": manifest_digest,
            "content_base64": base64.b64encode(manifest_bytes).decode(),
        },
        idempotency_key=f"evidence-manifest-{config.action_id}-{task.task_id}",
        timeout=120.0,
    )
    return manifest_digest, str(uploaded_manifest["path"])


def _submit_attempt(
    config: WorkerConfig,
    task: LockedTask,
    result: dict[str, Any] | None,
    stderr: str,
    evidence_digest: str,
    evidence_path: str,
    *,
    timed_out: bool = False,
) -> None:
    outcome, replacement = _exception_outcome(result, stderr, timed_out=timed_out)
    metrics, _ = _metrics(result)
    client = _ControlClient(config.campaign_id, task.task_id)
    client.request(
        "POST",
        f"{client.prefix}/attempts",
        body={
            "action_id": config.action_id,
            "outcome": outcome,
            "replacement_eligible": replacement,
            "evidence_digest": evidence_digest,
            "evidence_path": evidence_path,
            "cost_microusd": _cost_microusd(config, result),
            "metrics": metrics,
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "confirmed": True,
        },
        idempotency_key=f"attempt-{config.action_id}-{task.task_id}",
        timeout=120.0,
    )


def _log(event: dict[str, object]) -> None:
    print(json.dumps(event, sort_keys=True), flush=True)


def _sensitive_output_environment() -> tuple[str, ...]:
    bare_names = {
        "ACCESS_KEY",
        "API_KEY",
        "CREDENTIAL",
        "PASSWORD",
        "PRIVATE_KEY",
        "SECRET",
        "TOKEN",
    }
    suffixes = (
        "_ACCESS_KEY",
        "_API_KEY",
        "_CREDENTIAL",
        "_PASSWORD",
        "_PRIVATE_KEY",
        "_SECRET",
        "_TOKEN",
    )
    return tuple(
        name
        for name, value in os.environ.items()
        if value
        and (
            name in _SENSITIVE_OUTPUT_ENVIRONMENT
            or name.upper() in bare_names
            or name.upper().endswith(suffixes)
        )
    )


def _sensitive_output_values() -> tuple[str, ...]:
    values = {os.environ[name] for name in _sensitive_output_environment()}
    if any(len(value) > _MAX_SENSITIVE_OUTPUT_CHARS for value in values):
        raise RuntimeError("sensitive worker setting exceeds the output safety limit")
    return tuple(sorted(values, key=len, reverse=True))


def _redaction_marker(sensitive_values: tuple[str, ...]) -> str:
    for marker in ("<redacted>", "[private]", "***"):
        if all(value not in marker for value in sensitive_values):
            return marker
    return ""


def _path_contains_sensitive_value(
    path: Path, sensitive_values: tuple[str, ...]
) -> bool:
    encoded = tuple(
        value.encode("utf-8") for value in sensitive_values if value.encode("utf-8")
    )
    carry_bytes = max((len(value) for value in encoded), default=1) - 1
    pending = b""
    with path.open("rb") as handle:
        while chunk := handle.read(_LOG_READ_CHARS):
            pending += chunk
            if any(value in pending for value in encoded):
                return True
            pending = pending[-carry_bytes:] if carry_bytes else b""
    return False


def _path_metadata_contains_sensitive_value(
    root: Path, path: Path, sensitive_values: tuple[str, ...]
) -> bool:
    values = [path.relative_to(root).as_posix()]
    if path.is_symlink():
        values.append(os.readlink(path))
    return any(sensitive in value for value in values for sensitive in sensitive_values)


def _redact_pending_output(
    pending: str,
    sensitive_values: tuple[str, ...],
    marker: str,
    *,
    final: bool,
) -> tuple[str, str]:
    redacted: list[str] = []
    while pending:
        matches = [value for value in sensitive_values if pending.startswith(value)]
        longer_prefix = not final and any(
            value.startswith(pending) and len(value) > len(pending)
            for value in sensitive_values
        )
        if matches and not longer_prefix:
            match = matches[0]
            redacted.append(marker)
            pending = pending[len(match) :]
        elif not final and any(value.startswith(pending) for value in sensitive_values):
            break
        else:
            redacted.append(pending[0])
            pending = pending[1:]
    return "".join(redacted), pending


def _run_logged_command(  # noqa: C901 -- bounded streaming and process cleanup
    command: list[str], timeout_seconds: int
) -> tuple[str, bool]:
    """Copy bounded redacted output to Job logs and kill the group on timeout."""
    sensitive_values = _sensitive_output_values()
    environment = {
        name: value
        for name, value in os.environ.items()
        if name in _HARBOR_CHILD_ENVIRONMENT
    }
    process = subprocess.Popen(
        command,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    chunks: deque[str] = deque()
    retained_chars = 0
    streamed_chars = 0
    stream_truncated = False
    reader_errors: list[BaseException] = []
    marker = _redaction_marker(sensitive_values)

    def _emit(value: str) -> None:
        nonlocal retained_chars, streamed_chars, stream_truncated
        if not value:
            return
        available = max(0, _MAX_STREAMED_OUTPUT_CHARS - streamed_chars)
        if available:
            print(value[:available], end="", flush=True)
            streamed_chars += min(available, len(value))
        if len(value) > available and not stream_truncated:
            print("\n<output truncated>\n", end="", flush=True)
            stream_truncated = True
        chunks.append(value)
        retained_chars += len(value)
        while retained_chars > _MAX_RETAINED_OUTPUT_CHARS and chunks:
            overflow = retained_chars - _MAX_RETAINED_OUTPUT_CHARS
            first = chunks[0]
            if len(first) <= overflow:
                retained_chars -= len(chunks.popleft())
            else:
                chunks[0] = first[overflow:]
                retained_chars -= overflow

    def _copy() -> None:
        try:
            if process.stdout is None:
                return
            pending = ""
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            while raw := os.read(process.stdout.fileno(), _LOG_READ_CHARS):
                value = decoder.decode(raw)
                pending += value
                redacted, pending = _redact_pending_output(
                    pending, sensitive_values, marker, final=False
                )
                _emit(redacted)
            pending += decoder.decode(b"", final=True)
            redacted, _ = _redact_pending_output(
                pending, sensitive_values, marker, final=True
            )
            _emit(redacted)
        except BaseException as error:
            reader_errors.append(error)

    reader = threading.Thread(target=_copy, daemon=True)
    reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            process.kill()
        process.wait()
    if not timed_out:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    reader.join(timeout=_LOG_DRAIN_SECONDS)
    if reader.is_alive():
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        reader.join(timeout=_LOG_DRAIN_SECONDS)
    if reader.is_alive():
        if process.stdout is not None:
            process.stdout.close()
        reader.join(timeout=_LOG_DRAIN_SECONDS)
    if reader.is_alive():
        raise RuntimeError("command output reader did not stop")
    if reader_errors:
        raise RuntimeError("command output reader failed") from reader_errors[0]
    return "".join(chunks), timed_out


def _run_task(config: WorkerConfig, task: LockedTask, root: Path) -> str:
    path = _job_config(config, task, root)
    _log(
        {
            "status": "task_start",
            "task_id": task.task_id,
            "timeout_seconds": task.timeout_seconds,
        }
    )
    output, timed_out = _run_logged_command(
        ["harbor", "run", "--config", str(path), "--yes"],
        task.timeout_seconds + 600,
    )
    result_path = _result_path(root, task)
    if not result_path:
        raise RuntimeError("Harbor did not write a trial result")
    observed_lock_path = result_path.parent / "lock.json"
    if not observed_lock_path.is_file():
        raise RuntimeError("Harbor did not write a trial lock")
    observed_lock = TrialLock.model_validate_json(observed_lock_path.read_text())
    if observed_lock != task.trial_lock:
        raise RuntimeError("executed Harbor trial lock differs from preparation")
    result = json.loads(result_path.read_text())
    sensitive_values = _sensitive_output_values()
    if result_path:
        for trial_path in result_path.parent.rglob("*"):
            metadata_leaked = _path_metadata_contains_sensitive_value(
                result_path.parent, trial_path, sensitive_values
            )
            content_leaked = (
                trial_path.is_file()
                and not trial_path.is_symlink()
                and _path_contains_sensitive_value(trial_path, sensitive_values)
            )
            if metadata_leaked or content_leaked:
                raise RuntimeError(
                    "sensitive worker setting leaked into trial evidence"
                )
    archive = _archive_trial(root, task, result_path, output)
    digest, evidence_path = _upload_evidence(config, task, archive)
    _submit_attempt(
        config,
        task,
        result,
        output,
        digest,
        evidence_path,
        timed_out=timed_out,
    )
    return task.task_id


def _fill_available_slots(
    executor: concurrent.futures.ThreadPoolExecutor,
    futures: dict[concurrent.futures.Future[str], LockedTask],
    pending: Iterator[LockedTask],
    config: WorkerConfig,
    root: Path,
    width: int,
) -> None:
    while len(futures) < width:
        try:
            task = next(pending)
        except StopIteration:
            return
        futures[executor.submit(_run_task, config, task, root)] = task


def _run_assigned_tasks(
    config: WorkerConfig, root: Path
) -> tuple[list[str], list[BaseException]]:
    completed: list[str] = []
    failures: list[BaseException] = []
    pending = iter(config.tasks)
    width = min(config.concurrency, len(config.tasks))

    with concurrent.futures.ThreadPoolExecutor(max_workers=width) as executor:
        futures: dict[concurrent.futures.Future[str], LockedTask] = {}

        _fill_available_slots(executor, futures, pending, config, root, width)
        accepting = True
        while futures:
            done, _ = concurrent.futures.wait(
                futures, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in done:
                futures.pop(future)
                try:
                    completed.append(future.result())
                except BaseException as error:
                    failures.append(error)
            if failures:
                accepting = False
            if accepting:
                _fill_available_slots(executor, futures, pending, config, root, width)

    return completed, failures


def main() -> None:  # noqa: C901 -- bounded orchestration
    if _required("HARBOR_HF_WORKER_ROLE") != "execution":
        raise RuntimeError("control worker role is invalid")
    if os.environ.get("HF_TOKEN") or os.environ.get("HF_INFERENCE_TOKEN"):
        raise RuntimeError("control worker must not receive persistent credentials")
    _log(
        {
            "status": "starting",
            "action_id": _required("HARBOR_HF_ACTION_ID"),
            "campaign_id": _required("HARBOR_HF_CAMPAIGN_ID"),
            "task_ids": list(_assigned_task_ids()),
        }
    )
    lock = _read_lock(_required("HARBOR_HF_CAMPAIGN_ID"))
    config = _locked_config(lock)
    if version("harbor") != config.harbor_version:
        raise RuntimeError("Harbor version does not match the deployment profile")
    if _required("HARBOR_HF_WORKER_REVISION") != config.worker_revision:
        raise RuntimeError("worker revision does not match the deployment profile")
    with tempfile.TemporaryDirectory(prefix="harbor-hf-control-worker-") as temporary:
        root = Path(temporary)
        completed, failures = _run_assigned_tasks(config, root)
        if failures:
            raise RuntimeError(
                f"{len(failures)} control worker task(s) failed before receipt; "
                f"first={type(failures[0]).__name__}"
            ) from failures[0]
        _log(
            {
                "status": "complete",
                "campaign_id": config.campaign_id,
                "action_id": config.action_id,
                "task_count": len(completed),
                "assigned_task_count": len(config.tasks),
                "partial": len(completed) < len(config.tasks),
            }
        )


if __name__ == "__main__":
    main()

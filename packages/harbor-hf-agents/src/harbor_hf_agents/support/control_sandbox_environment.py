"""Harbor environment backed by capability-scoped control-service Sandboxes."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shlex
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, override
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities
from harbor.environments.definition import require_agent_environment_definition
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

_CHUNK_BYTES = 16 * 1024 * 1024
_TERMINAL_STATES = {"CANCELED", "CANCELLED", "COMPLETED", "DELETED", "ERROR", "STOPPED"}


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required control Sandbox setting {name} is missing")
    return value


def _origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("control Sandbox URL must be an HTTPS origin")
    return value.rstrip("/")


def _digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _image_repository(value: str) -> str:
    without_digest = value.split("@", 1)[0]
    tail = without_digest.rsplit("/", 1)[-1]
    return without_digest.rsplit(":", 1)[0] if ":" in tail else without_digest


class _ControlClient:
    def __init__(self, campaign_id: str, task_id: str) -> None:
        self.origin = _origin(_required("HARBOR_HF_CONTROL_URL"))
        self.capability = _required("HARBOR_HF_WORKER_CAPABILITY")
        self.campaign_id = campaign_id
        self.task_id = task_id
        self.prefix = (
            f"/api/v1/campaigns/{quote(campaign_id, safe='')}"
            f"/tasks/{quote(task_id, safe='')}"
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        idempotency_key: str,
        retry_safe: bool = True,
        timeout: float = 120.0,
    ) -> dict[str, Any]:
        payload = (
            None if body is None else json.dumps(body, separators=(",", ":")).encode()
        )
        headers = {
            "Accept": "application/json",
            "Idempotency-Key": idempotency_key,
            "X-Harbor-HF-Worker-Capability": self.capability,
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        attempts = 4 if retry_safe else 1
        for attempt in range(attempts):
            request = Request(
                f"{self.origin}{path}",
                data=payload,
                headers=headers,
                method=method,
            )
            try:
                with urlopen(request, timeout=timeout) as response:
                    value = json.loads(response.read())
                    if not isinstance(value, dict):
                        raise RuntimeError("control Sandbox response must be an object")
                    return value
            except HTTPError as error:
                detail = error.read(4096).decode("utf-8", "replace")
                if (
                    retry_safe
                    and error.code in {429, 502, 503, 504}
                    and attempt + 1 < attempts
                ):
                    delay = min(
                        15.0,
                        float(error.headers.get("Retry-After", "0") or 0) or 2**attempt,
                    )
                    time.sleep(delay)
                    continue
                raise RuntimeError(
                    f"control Sandbox API returned HTTP {error.code}: {detail}"
                ) from error
            except URLError as error:
                if retry_safe and attempt + 1 < attempts:
                    time.sleep(2**attempt)
                    continue
                raise RuntimeError("control Sandbox API request failed") from error
        raise RuntimeError("control Sandbox API retry budget is exhausted")


class ControlSandboxEnvironment(BaseEnvironment):
    """Run one Harbor trial through the hosted capability-scoped Sandbox API."""

    def __init__(
        self,
        environment_dir: Path,
        environment_name: str,
        session_id: str,
        trial_paths: TrialPaths,
        task_env_config: EnvironmentConfig,
        *args: Any,  # noqa: ANN401 -- Harbor environment API
        control_task_id: str,
        control_max_command_seconds: int,
        **kwargs: Any,  # noqa: ANN401 -- Harbor environment API
    ) -> None:
        if not control_task_id:
            raise ValueError("control_task_id is required")
        if (
            not isinstance(control_max_command_seconds, int)
            or isinstance(control_max_command_seconds, bool)
            or control_max_command_seconds < 1
        ):
            raise ValueError("control_max_command_seconds must be a positive integer")
        self._campaign_id = _required("HARBOR_HF_CAMPAIGN_ID")
        self._task_id = control_task_id
        self._max_command_seconds = control_max_command_seconds
        self._client = _ControlClient(self._campaign_id, self._task_id)
        self._sandbox_id: str | None = None
        self._operation = 0
        super().__init__(
            environment_dir=environment_dir,
            environment_name=environment_name,
            session_id=session_id,
            trial_paths=trial_paths,
            task_env_config=task_env_config,
            **kwargs,
        )

    @staticmethod
    @override
    def type() -> str:
        return "harbor-hf-control-sandbox"

    @classmethod
    def preflight(cls) -> None:
        del cls
        for name in (
            "HARBOR_HF_CONTROL_URL",
            "HARBOR_HF_WORKER_CAPABILITY",
            "HARBOR_HF_CAMPAIGN_ID",
        ):
            _required(name)
        if os.environ.get("HF_TOKEN"):
            raise RuntimeError("control Sandbox worker must not receive HF_TOKEN")

    @property
    @override
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities()

    @override
    def _validate_definition(self) -> None:
        require_agent_environment_definition(
            self.environment_dir,
            docker_image=self.task_env_config.docker_image,
        )
        if not self.task_env_config.docker_image:
            raise ValueError("control Sandbox requires a prebuilt task image")
        prepared = self._client.request(
            "GET",
            (
                f"/api/v1/campaigns/{self._campaign_id}/prepared-job/trials/"
                f"{self._task_id}"
            ),
            idempotency_key=f"prepared-environment-{self._task_id}",
            timeout=60.0,
        )
        declared = str(prepared.get("declared_image", ""))
        resolved = str(prepared.get("image", ""))
        if declared != self.task_env_config.docker_image or _image_repository(
            declared
        ) != _image_repository(resolved):
            raise ValueError("prepared task image does not match Harbor task source")

    def _key(self, operation: str) -> str:
        self._operation += 1
        seed = (
            f"{self._campaign_id}:{self._task_id}:{self.session_id}:"
            f"{operation}:{self._operation}"
        )
        return f"control-sandbox-{hashlib.sha256(seed.encode()).hexdigest()[:32]}"

    def _sandbox_path(self, suffix: str = "") -> str:
        if not self._sandbox_id:
            raise RuntimeError("control Sandbox is not running")
        sandbox_id = quote(self._sandbox_id, safe="")
        return f"{self._client.prefix}/sandboxes/{sandbox_id}{suffix}"

    @override
    async def start(self, force_build: bool) -> None:
        del force_build
        value = await asyncio.to_thread(
            self._client.request,
            "POST",
            f"{self._client.prefix}/sandboxes",
            idempotency_key=self._key("create"),
            timeout=180.0,
        )
        sandbox_id = value.get("sandbox_id")
        if not isinstance(sandbox_id, str) or not sandbox_id:
            raise RuntimeError("control Sandbox create response has no ID")
        self._sandbox_id = sandbox_id
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            observed = await asyncio.to_thread(
                self._client.request,
                "POST",
                self._sandbox_path("/observe"),
                idempotency_key=self._key("observe"),
                timeout=60.0,
            )
            state = str(observed.get("state", "UNKNOWN")).upper()
            if state == "RUNNING":
                try:
                    await self.ensure_dirs(self._mount_targets(writable_only=True))
                    await self._upload_environment_dir_after_start()
                except BaseException:
                    await self.stop(delete=True)
                    raise
                return
            if state in _TERMINAL_STATES:
                raise RuntimeError(
                    f"control Sandbox became terminal during start: {state}"
                )
            await asyncio.sleep(2)
        await self.stop(delete=True)
        raise RuntimeError("control Sandbox start timed out")

    @override
    async def stop(self, delete: bool) -> None:
        del delete
        if not self._sandbox_id:
            return
        try:
            value = await asyncio.to_thread(
                self._client.request,
                "DELETE",
                self._sandbox_path(),
                idempotency_key=self._key("close"),
                timeout=180.0,
            )
            state = str(value.get("state", "UNKNOWN")).upper()
            if state not in _TERMINAL_STATES:
                raise RuntimeError(f"control Sandbox close is not terminal: {state}")
        finally:
            self._sandbox_id = None

    @override
    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        merged = self._merge_env(env)
        script = command
        if merged:
            assignments = " ".join(
                f"{key}={shlex.quote(value)}" for key, value in sorted(merged.items())
            )
            script = f"env {assignments} /bin/sh -lc {shlex.quote(command)}"
        if user not in {None, "root", 0}:
            if not isinstance(user, str) or not user:
                raise ValueError("control Sandbox requires a named execution user")
            script = (
                f"runuser -u {shlex.quote(user)} -- /bin/sh -lc {shlex.quote(script)}"
            )
        timeout = self._max_command_seconds if timeout_sec is None else timeout_sec
        if timeout < 1 or timeout > self._max_command_seconds:
            raise ValueError("control Sandbox command timeout exceeds prepared limit")
        value = await asyncio.to_thread(
            self._client.request,
            "POST",
            self._sandbox_path("/exec"),
            body={
                "command": ["/bin/sh", "-lc", script],
                "cwd": cwd or self.task_env_config.workdir or "/app",
                "timeout_seconds": timeout,
            },
            idempotency_key=self._key("exec"),
            retry_safe=False,
            timeout=float(timeout + 60),
        )
        stdout = str(value.get("stdout") or "")
        stderr = str(value.get("stderr") or "")
        callback = self._output_callback()
        if callback:
            if stdout:
                await callback(stdout, "stdout")
            if stderr:
                await callback(stderr, "stderr")
        exit_code = value.get("exit_code")
        return ExecResult(
            stdout=stdout,
            stderr=stderr,
            return_code=exit_code if isinstance(exit_code, int) else -1,
        )

    async def _write(
        self, target_path: str, content: bytes, mode: str | None = None
    ) -> None:
        body: dict[str, Any] = {
            "path": target_path,
            "content_digest": _digest(content),
            "content_base64": base64.b64encode(content).decode(),
        }
        if mode:
            body["mode"] = mode
        await asyncio.to_thread(
            self._client.request,
            "PUT",
            self._sandbox_path("/files"),
            body=body,
            idempotency_key=self._key("write"),
            timeout=180.0,
        )

    async def _read(self, source_path: str) -> bytes:
        value = await asyncio.to_thread(
            self._client.request,
            "POST",
            self._sandbox_path("/files/read"),
            body={"path": source_path},
            idempotency_key=self._key("read"),
            timeout=180.0,
        )
        content = value.get("content_base64")
        if not isinstance(content, str):
            raise RuntimeError("control Sandbox read response has no content")
        data = base64.b64decode(content, validate=True)
        if value.get("digest") != _digest(data) or value.get("size") != len(data):
            raise RuntimeError("control Sandbox read response failed integrity checks")
        return data

    @override
    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        source = Path(source_path)
        if source.stat().st_size <= _CHUNK_BYTES:
            await self._write(target_path, source.read_bytes())
            return
        prefix = f"/tmp/.hhf-upload-{uuid.uuid4().hex}"
        parts: list[str] = []
        with source.open("rb") as handle:
            index = 0
            while chunk := handle.read(_CHUNK_BYTES):
                path = f"{prefix}.{index:06d}"
                await self._write(path, chunk)
                parts.append(path)
                index += 1
        command = (
            "cat "
            + " ".join(shlex.quote(path) for path in parts)
            + f" > {shlex.quote(target_path)} && rm -f "
            + " ".join(shlex.quote(path) for path in parts)
        )
        result = await self.exec(command, cwd="/tmp", timeout_sec=300)
        if result.return_code != 0:
            raise RuntimeError("control Sandbox chunked upload assembly failed")

    @override
    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        target = Path(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        size_result = await self.exec(
            f"stat -c %s {shlex.quote(source_path)}", cwd="/tmp", timeout_sec=30
        )
        if size_result.return_code != 0:
            raise RuntimeError(f"control Sandbox file is unavailable: {source_path}")
        size = int((size_result.stdout or "").strip())
        if size <= _CHUNK_BYTES:
            target.write_bytes(await self._read(source_path))
            return
        prefix = f"/tmp/.hhf-download-{uuid.uuid4().hex}"
        split = await self.exec(
            "split "
            f"-b {_CHUNK_BYTES} -d -a 6 {shlex.quote(source_path)} "
            f"{shlex.quote(prefix)}.",
            cwd="/tmp",
            timeout_sec=300,
        )
        if split.return_code != 0:
            raise RuntimeError("control Sandbox chunked download split failed")
        try:
            with target.open("wb") as output:
                for index in range((size + _CHUNK_BYTES - 1) // _CHUNK_BYTES):
                    output.write(await self._read(f"{prefix}.{index:06d}"))
        finally:
            await self.exec(
                f"rm -f {shlex.quote(prefix)}.*", cwd="/tmp", timeout_sec=60
            )
        if target.stat().st_size != size:
            raise RuntimeError("control Sandbox chunked download size mismatch")

    @override
    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "upload.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                handle.add(source_dir, arcname=".")
            remote = f"/tmp/.hhf-upload-{uuid.uuid4().hex}.tar.gz"
            await self.upload_file(archive, remote)
            result = await self.exec(
                f"mkdir -p {shlex.quote(target_dir)} && "
                f"tar xzf {shlex.quote(remote)} -C {shlex.quote(target_dir)} && "
                f"rm -f {shlex.quote(remote)}",
                cwd="/tmp",
                timeout_sec=600,
            )
            if result.return_code != 0:
                raise RuntimeError("control Sandbox directory upload failed")

    @override
    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        remote = f"/tmp/.hhf-download-{uuid.uuid4().hex}.tar.gz"
        result = await self.exec(
            f"tar czf {shlex.quote(remote)} -C {shlex.quote(source_dir)} .",
            cwd="/tmp",
            timeout_sec=600,
        )
        if result.return_code != 0:
            raise RuntimeError("control Sandbox directory archive failed")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "download.tar.gz"
            await self.download_file(remote, archive)
            target = Path(target_dir)
            target.mkdir(parents=True, exist_ok=True)
            with tarfile.open(archive, "r:gz") as handle:
                handle.extractall(target, filter="data")
        await self.exec(f"rm -f {shlex.quote(remote)}", cwd="/tmp", timeout_sec=60)

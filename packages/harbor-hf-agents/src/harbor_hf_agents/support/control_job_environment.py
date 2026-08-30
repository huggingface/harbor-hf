"""Harbor environment backed by a task-owned OCI rootfs inside one HF Job."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any, override

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities
from harbor.environments.definition import require_agent_environment_definition
from harbor.models.task.config import EnvironmentConfig, TaskOS
from harbor.models.trial.paths import TrialPaths

from harbor_hf_agents.support.job_oci_runtime import (
    ImageLimits,
    IsolatedOciRuntime,
    OciImageIntegrityError,
    OciRuntimeError,
    OciRuntimeUnavailableError,
    OciTransferError,
    TransferLimits,
)

_FORBIDDEN_EXACT_NAMES = frozenset(
    {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HF_INFERENCE_TOKEN",
        "HF_TOKEN",
        "SSH_AUTH_SOCK",
    }
)
_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class JobEnvironmentError(RuntimeError):
    """Base error for isolated Job environment failures."""


class JobEnvironmentStateError(JobEnvironmentError):
    """Raised when an operation is attempted in the wrong lifecycle state."""


class JobEnvironmentTimeoutError(JobEnvironmentError):
    """Raised when a command exceeds the prepared phase timeout."""


class JobEnvironmentSecurityError(JobEnvironmentError):
    """Raised when task data violates an isolation or transfer boundary."""


class JobEnvironmentPreflightError(JobEnvironmentError):
    """Raised when the assigned Job cannot isolate a prepared task image."""


class ControlJobEnvironment(BaseEnvironment):
    """Run one prepared task image under a dedicated real host UID."""

    def __init__(
        self,
        environment_dir: Path,
        environment_name: str,
        session_id: str,
        trial_paths: TrialPaths,
        task_env_config: EnvironmentConfig,
        *args: Any,  # noqa: ANN401 -- Harbor environment API
        control_max_command_seconds: int,
        control_max_transfer_bytes: int,
        control_max_transfer_file_bytes: int,
        control_max_transfer_files: int,
        control_max_transfer_path_depth: int,
        control_max_image_bytes: int,
        control_max_image_entries: int,
        control_declared_task_image: str,
        control_task_image: str,
        **kwargs: Any,  # noqa: ANN401 -- Harbor environment API
    ) -> None:
        if (
            not isinstance(control_max_command_seconds, int)
            or isinstance(control_max_command_seconds, bool)
            or control_max_command_seconds < 1
        ):
            raise ValueError("control_max_command_seconds must be a positive integer")
        self._max_command_seconds = control_max_command_seconds
        self._transfer_limits = TransferLimits(
            max_total_bytes=control_max_transfer_bytes,
            max_file_bytes=control_max_transfer_file_bytes,
            max_files=control_max_transfer_files,
            max_path_depth=control_max_transfer_path_depth,
        )
        self._image_limits = ImageLimits(
            max_bytes=control_max_image_bytes,
            max_entries=control_max_image_entries,
        )
        task_image_mirror_repository = _ambient_value(
            "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY"
        )
        if not task_image_mirror_repository:
            raise JobEnvironmentPreflightError(
                "required Job worker setting "
                "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY is missing"
            )
        self._task_image_mirror_repository = task_image_mirror_repository
        if not task_env_config.docker_image:
            raise JobEnvironmentPreflightError(
                "ControlJobEnvironment requires a prebuilt task image"
            )
        if task_env_config.docker_image != control_declared_task_image:
            raise JobEnvironmentPreflightError(
                "Harbor task environment image differs from preparation"
            )
        if re.fullmatch(
            r".+@sha256:[0-9a-f]{64}", control_task_image
        ) is None or control_task_image != _ambient_value("HARBOR_HF_TASK_IMAGE"):
            raise JobEnvironmentPreflightError(
                "prepared task image does not match the Job launch"
            )
        task_env_config = task_env_config.model_copy(
            update={"docker_image": control_task_image}
        )
        self._runtime: IsolatedOciRuntime | None = None
        self._started = False
        super().__init__(
            environment_dir,
            environment_name,
            session_id,
            trial_paths,
            task_env_config,
            *args,
            **kwargs,
        )

    @staticmethod
    @override
    def type() -> str:
        return "harbor-hf-control-job"

    @classmethod
    @override
    def preflight(cls) -> None:
        """Verify authority scrubbing and the host UID isolation boundary."""
        del cls
        _validate_worker_platform()
        _validate_worker_authority()
        try:
            IsolatedOciRuntime.preflight()
        except OciRuntimeUnavailableError as error:
            raise JobEnvironmentPreflightError(str(error)) from error

    @property
    @override
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities(mounted=False)

    @override
    def _validate_definition(self) -> None:
        if self.task_env_config.os != TaskOS.LINUX:
            raise JobEnvironmentPreflightError(
                "ControlJobEnvironment supports Linux task images only"
            )
        if self.extra_docker_compose_paths:
            raise JobEnvironmentPreflightError(
                "ControlJobEnvironment does not support Docker Compose overlays"
            )
        require_agent_environment_definition(
            self.environment_dir,
            docker_image=self.task_env_config.docker_image,
        )
        for mount in self._mounts:
            if mount["type"] != "bind":
                raise JobEnvironmentPreflightError(
                    "ControlJobEnvironment supports bind mounts only"
                )

    @override
    async def start(self, force_build: bool) -> None:
        """Fetch and start the prepared task image behind the UID boundary."""
        if self._started:
            raise JobEnvironmentStateError("ControlJobEnvironment is already started")
        if force_build:
            raise JobEnvironmentPreflightError(
                "ControlJobEnvironment cannot build a prepared task image"
            )
        self.preflight()
        image = self.task_env_config.docker_image
        if image is None:
            raise JobEnvironmentPreflightError("prepared task image is missing")
        runtime = IsolatedOciRuntime(
            image,
            control_task_image_mirror_repository=self._task_image_mirror_repository,
            transfer_limits=self._transfer_limits,
            image_limits=self._image_limits,
        )
        self._runtime = runtime
        try:
            await runtime.start()
            self._started = True
            await self.ensure_dirs(self._mount_targets(writable_only=True))
            await self._upload_environment_dir_after_start()
        except OciImageIntegrityError as error:
            await self.stop(delete=True)
            raise JobEnvironmentSecurityError(str(error)) from error
        except OciRuntimeUnavailableError as error:
            await self.stop(delete=True)
            raise JobEnvironmentPreflightError(str(error)) from error
        except BaseException:
            await self.stop(delete=True)
            raise

    @override
    async def stop(self, delete: bool) -> None:
        """Kill every dedicated-UID process and remove the unpacked rootfs."""
        del delete
        runtime = self._runtime
        if runtime is None:
            return
        try:
            await runtime.stop()
        except OciRuntimeUnavailableError as error:
            raise JobEnvironmentPreflightError(str(error)) from error
        self._runtime = None
        self._started = False

    async def quiesce(self) -> None:
        """Kill task processes after the agent while preserving verifier state."""
        runtime = self._runtime
        if not self._started or runtime is None:
            return
        try:
            await runtime.quiesce()
        except OciRuntimeUnavailableError as error:
            raise JobEnvironmentPreflightError(str(error)) from error
        except OciRuntimeError as error:
            raise JobEnvironmentError(str(error)) from error

    async def start_background(
        self,
        command: str,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        user: str | int | None = None,
    ) -> None:
        """Start a command that is bounded by the task environment lifecycle."""
        runtime = self._require_runtime()
        child_environment = self._child_environment(env)
        try:
            await runtime.start_background(
                command,
                cwd=cwd,
                environment=child_environment,
                user=self._resolve_user(user),
            )
        except OciTransferError as error:
            raise JobEnvironmentSecurityError(str(error)) from error
        except OciRuntimeUnavailableError as error:
            raise JobEnvironmentPreflightError(str(error)) from error
        except OciRuntimeError as error:
            raise JobEnvironmentError(str(error)) from error

    @override
    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        """Execute one bounded command with an authority-free environment."""
        runtime = self._require_runtime()
        timeout = self._command_timeout(timeout_sec)
        child_environment = self._child_environment(env)
        try:
            stdout, stderr, return_code = await runtime.exec(
                command,
                cwd=cwd,
                environment=child_environment,
                timeout_seconds=timeout,
                user=self._resolve_user(user),
            )
        except TimeoutError as error:
            await self.stop(delete=True)
            raise JobEnvironmentTimeoutError(
                f"isolated Job command exceeded {timeout} seconds"
            ) from error
        except OciTransferError as error:
            raise JobEnvironmentSecurityError(str(error)) from error
        except OciRuntimeUnavailableError as error:
            raise JobEnvironmentPreflightError(str(error)) from error
        except OciRuntimeError as error:
            raise JobEnvironmentError(str(error)) from error
        callback = self._output_callback()
        if callback is not None:
            if stdout:
                await callback(stdout, "stdout")
            if stderr:
                await callback(stderr, "stderr")
        return ExecResult(stdout=stdout, stderr=stderr, return_code=return_code)

    @override
    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        """Copy one bounded file into the unpacked task rootfs."""
        runtime = self._require_runtime()
        try:
            await runtime.upload_file(
                Path(source_path),
                target_path,
                timeout_seconds=self._max_command_seconds,
            )
        except OciTransferError as error:
            raise JobEnvironmentSecurityError(str(error)) from error

    @override
    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        """Copy one bounded file from the unpacked task rootfs."""
        runtime = self._require_runtime()
        try:
            await runtime.download_file(
                source_path,
                Path(target_path),
                timeout_seconds=self._max_command_seconds,
            )
        except OciTransferError as error:
            raise JobEnvironmentSecurityError(str(error)) from error

    @override
    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        """Copy bounded directory contents into the unpacked task rootfs."""
        runtime = self._require_runtime()
        try:
            await runtime.upload_dir(
                Path(source_dir),
                target_dir,
                timeout_seconds=self._max_command_seconds,
            )
        except OciTransferError as error:
            raise JobEnvironmentSecurityError(str(error)) from error

    @override
    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        """Copy bounded directory contents from the unpacked task rootfs."""
        runtime = self._require_runtime()
        try:
            await runtime.download_dir(
                source_dir,
                Path(target_dir),
                timeout_seconds=self._max_command_seconds,
            )
        except OciTransferError as error:
            raise JobEnvironmentSecurityError(str(error)) from error

    def _require_runtime(self) -> IsolatedOciRuntime:
        if not self._started or self._runtime is None:
            raise JobEnvironmentStateError("ControlJobEnvironment is not started")
        return self._runtime

    def _command_timeout(self, requested: int | None) -> int:
        if requested is None:
            return self._max_command_seconds
        if (
            not isinstance(requested, int)
            or isinstance(requested, bool)
            or requested < 1
        ):
            raise ValueError("command timeout must be a positive integer")
        if requested > self._max_command_seconds:
            raise ValueError("command timeout exceeds the prepared phase limit")
        return requested

    def _child_environment(self, explicit: dict[str, str] | None) -> dict[str, str]:
        merged = self._merge_env(explicit) or {}
        _validate_child_environment(merged)
        return merged


def _ambient_value(name: str) -> str | None:
    try:
        return os.environ[name]
    except KeyError:
        return None


def _validate_worker_platform() -> None:
    if sys.platform != "linux":
        raise JobEnvironmentPreflightError(
            "ControlJobEnvironment requires a Linux HF Job"
        )
    if os.geteuid() != 0:
        raise JobEnvironmentPreflightError(
            "ControlJobEnvironment requires the trusted worker to run as root"
        )


def _validate_worker_authority() -> None:
    for name in (
        "HARBOR_HF_WORKER_CAPABILITY",
        "HARBOR_HF_RUN_ID",
        "HARBOR_HF_ACTION_ID",
        "HARBOR_HF_TASK_IMAGE",
        "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY",
        "HARBOR_HF_MAX_IMAGE_BYTES",
        "HARBOR_HF_MAX_IMAGE_ENTRIES",
    ):
        if not _ambient_value(name):
            raise JobEnvironmentPreflightError(
                f"required Job worker setting {name} is missing"
            )
    for name in ("HF_TOKEN", "HF_INFERENCE_TOKEN"):
        if _ambient_value(name):
            raise JobEnvironmentPreflightError(
                f"Job worker must not retain {name} after root bootstrap"
            )


def _validate_child_environment(environment: dict[str, str]) -> None:
    authority_values = _control_authority_values()
    for name, value in environment.items():
        if not isinstance(value, str):
            raise JobEnvironmentSecurityError(
                f"task command environment value must be text: {name}"
            )
        if name in _FORBIDDEN_EXACT_NAMES or name.startswith("HARBOR_HF_"):
            raise JobEnvironmentSecurityError(
                f"task command cannot receive control authority {name}"
            )
        if _ENVIRONMENT_NAME.fullmatch(name) is None:
            raise JobEnvironmentSecurityError(
                f"task command environment name is invalid: {name}"
            )
        if "\0" in value:
            raise JobEnvironmentSecurityError(
                f"task command environment value contains NUL: {name}"
            )
        if value in authority_values:
            raise JobEnvironmentSecurityError(
                f"task command environment value aliases control authority: {name}"
            )


def _control_authority_values() -> set[str]:
    values: set[str] = set()
    for name in (*_FORBIDDEN_EXACT_NAMES, "HARBOR_HF_WORKER_CAPABILITY"):
        value = _ambient_value(name)
        if value:
            values.add(value)
    return values

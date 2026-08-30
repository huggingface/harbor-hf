from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import pytest
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

from harbor_hf_agents.support import control_job_environment as control
from harbor_hf_agents.support.control_job_environment import (
    ControlJobEnvironment,
    JobEnvironmentPreflightError,
    JobEnvironmentSecurityError,
    JobEnvironmentTimeoutError,
)
from harbor_hf_agents.support.job_oci_runtime import OciRuntimeUnavailableError

_TASK_IMAGE = (
    "example.invalid/task@sha256:"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)
_DECLARED_TASK_IMAGE = "example.invalid/task:release"
_MIRROR_REPOSITORY = "mirror.example/harbor-hf/tasks"


class FakeRuntime:
    """Record environment calls without weakening production isolation."""

    instances: ClassVar[list[FakeRuntime]] = []
    preflight_error: ClassVar[BaseException | None] = None
    exec_error: BaseException | None = None

    def __init__(
        self,
        image: str,
        transfer_limits: object,
        image_limits: object,
        *,
        control_task_image_mirror_repository: str,
    ) -> None:
        del transfer_limits, image_limits
        self.image = image
        self.task_image_mirror_repository = control_task_image_mirror_repository
        self.started = False
        self.stopped = False
        self.quiesced = False
        self.exec_calls: list[dict[str, object]] = []
        self.background_calls: list[dict[str, object]] = []
        self.transfer_calls: list[tuple[str, object, object]] = []
        type(self).instances.append(self)

    @staticmethod
    def preflight() -> None:
        if FakeRuntime.preflight_error is not None:
            raise FakeRuntime.preflight_error

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def quiesce(self) -> None:
        self.quiesced = True

    async def start_background(
        self,
        command: str,
        *,
        cwd: str | None,
        environment: dict[str, str],
        user: str | int | None,
    ) -> None:
        self.background_calls.append(
            {
                "command": command,
                "cwd": cwd,
                "environment": environment,
                "user": user,
            }
        )

    async def exec(
        self,
        command: str,
        *,
        cwd: str | None,
        environment: dict[str, str],
        timeout_seconds: int,
        user: str | int | None,
    ) -> tuple[str, str, int]:
        self.exec_calls.append(
            {
                "command": command,
                "cwd": cwd,
                "environment": environment,
                "timeout_seconds": timeout_seconds,
                "user": user,
            }
        )
        if self.exec_error is not None:
            raise self.exec_error
        return ("ok\n", "", 0)

    async def upload_file(
        self,
        source: Path,
        target: str,
        *,
        timeout_seconds: int,
    ) -> None:
        del timeout_seconds
        self.transfer_calls.append(("upload_file", source, target))

    async def download_file(
        self,
        source: str,
        target: Path,
        *,
        timeout_seconds: int,
    ) -> None:
        del timeout_seconds
        self.transfer_calls.append(("download_file", source, target))

    async def upload_dir(
        self,
        source: Path,
        target: str,
        *,
        timeout_seconds: int,
    ) -> None:
        del timeout_seconds
        self.transfer_calls.append(("upload_dir", source, target))

    async def download_dir(
        self,
        source: str,
        target: Path,
        *,
        timeout_seconds: int,
    ) -> None:
        del timeout_seconds
        self.transfer_calls.append(("download_dir", source, target))


@pytest.fixture(autouse=True)
def _trusted_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeRuntime.instances.clear()
    FakeRuntime.preflight_error = None
    monkeypatch.setattr(control, "IsolatedOciRuntime", FakeRuntime)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("os.geteuid", lambda: 0)
    monkeypatch.setenv("HARBOR_HF_WORKER_CAPABILITY", "worker-capability")
    monkeypatch.setenv("HARBOR_HF_RUN_ID", "run-id")
    monkeypatch.setenv("HARBOR_HF_ACTION_ID", "action-id")
    monkeypatch.setenv("HARBOR_HF_TASK_IMAGE", _TASK_IMAGE)
    monkeypatch.setenv(
        "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY",
        _MIRROR_REPOSITORY,
    )
    monkeypatch.setenv("HARBOR_HF_MAX_IMAGE_BYTES", "1024")
    monkeypatch.setenv("HARBOR_HF_MAX_IMAGE_ENTRIES", "8")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HF_INFERENCE_TOKEN", raising=False)


def _environment(tmp_path: Path, *, timeout: int = 5) -> ControlJobEnvironment:
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    trial_dir = tmp_path / "trial"
    trial_dir.mkdir()
    return ControlJobEnvironment(
        environment_dir=environment_dir,
        environment_name="isolated-job",
        session_id="test-session",
        trial_paths=TrialPaths(trial_dir),
        task_env_config=EnvironmentConfig(docker_image=_DECLARED_TASK_IMAGE),
        control_max_command_seconds=timeout,
        control_max_transfer_bytes=1024,
        control_max_transfer_file_bytes=512,
        control_max_transfer_files=8,
        control_max_transfer_path_depth=4,
        control_max_image_bytes=1024,
        control_max_image_entries=8,
        control_declared_task_image=_DECLARED_TASK_IMAGE,
        control_task_image=_TASK_IMAGE,
    )


def test_requires_task_image_mirror_repository(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY")

    with pytest.raises(
        JobEnvironmentPreflightError,
        match="HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY",
    ):
        _environment(tmp_path)


@pytest.mark.asyncio
async def test_exec_passes_only_explicit_task_environment(tmp_path: Path) -> None:
    environment = _environment(tmp_path)
    await environment.start(force_build=False)

    result = await environment.exec(
        "env",
        env={"VISIBLE_TASK_SETTING": "visible"},
        user="harbor-agent",
    )

    assert result.return_code == 0
    runtime = FakeRuntime.instances[-1]
    assert runtime.image == _TASK_IMAGE
    assert runtime.task_image_mirror_repository == _MIRROR_REPOSITORY
    assert runtime.exec_calls == [
        {
            "command": "env",
            "cwd": None,
            "environment": {"VISIBLE_TASK_SETTING": "visible"},
            "timeout_seconds": 5,
            "user": "harbor-agent",
        }
    ]
    await environment.stop(delete=True)
    assert runtime.stopped is True


@pytest.mark.asyncio
async def test_rejects_command_timeout_above_prepared_limit(tmp_path: Path) -> None:
    environment = _environment(tmp_path, timeout=5)
    await environment.start(force_build=False)

    with pytest.raises(ValueError, match="exceeds the prepared phase limit"):
        await environment.exec("true", timeout_sec=6)

    assert FakeRuntime.instances[-1].exec_calls == []


@pytest.mark.asyncio
async def test_rejects_control_authority_under_an_alias(tmp_path: Path) -> None:
    environment = _environment(tmp_path)
    await environment.start(force_build=False)

    with pytest.raises(JobEnvironmentSecurityError, match="aliases control authority"):
        await environment.exec("true", env={"TASK_VALUE": "worker-capability"})


@pytest.mark.asyncio
async def test_timeout_destroys_the_whole_task_runtime(tmp_path: Path) -> None:
    environment = _environment(tmp_path, timeout=1)
    await environment.start(force_build=False)
    runtime = FakeRuntime.instances[-1]
    runtime.exec_error = TimeoutError()

    with pytest.raises(JobEnvironmentTimeoutError, match="exceeded 1 seconds"):
        await environment.exec("setsid sleep 30")

    await environment.quiesce()

    assert runtime.stopped is True
    assert runtime.quiesced is False


@pytest.mark.asyncio
async def test_transfers_use_the_isolated_runtime(tmp_path: Path) -> None:
    environment = _environment(tmp_path)
    await environment.start(force_build=False)
    source = tmp_path / "source"
    source.write_text("value", encoding="utf-8")
    target = tmp_path / "target"

    await environment.upload_file(source, "/workspace/source")
    await environment.download_file("/workspace/result", target)
    await environment.upload_dir(tmp_path, "/workspace/tree")
    await environment.download_dir("/workspace/tree", target)

    assert FakeRuntime.instances[-1].transfer_calls == [
        ("upload_file", source, "/workspace/source"),
        ("download_file", "/workspace/result", target),
        ("upload_dir", tmp_path, "/workspace/tree"),
        ("download_dir", "/workspace/tree", target),
    ]


@pytest.mark.asyncio
async def test_background_command_uses_the_task_lifecycle_without_a_timeout(
    tmp_path: Path,
) -> None:
    environment = _environment(tmp_path, timeout=1)
    await environment.start(force_build=False)

    await environment.start_background(
        "tmux new-session -d",
        env={"VISIBLE_TASK_SETTING": "visible"},
        user="root",
    )

    assert FakeRuntime.instances[-1].background_calls == [
        {
            "command": "tmux new-session -d",
            "cwd": None,
            "environment": {"VISIBLE_TASK_SETTING": "visible"},
            "user": "root",
        }
    ]


@pytest.mark.asyncio
async def test_quiesce_retains_runtime_for_verifier_exec(tmp_path: Path) -> None:
    environment = _environment(tmp_path)
    await environment.start(force_build=False)
    runtime = FakeRuntime.instances[-1]

    await environment.quiesce()
    result = await environment.exec("verify")

    assert runtime.quiesced is True
    assert runtime.stopped is False
    assert result.return_code == 0


def test_preflight_rejects_a_persistent_inference_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HF_INFERENCE_TOKEN", "persistent-token")

    with pytest.raises(JobEnvironmentPreflightError, match="must not retain"):
        ControlJobEnvironment.preflight()


def test_preflight_classifies_missing_uid_support_as_infrastructure() -> None:
    FakeRuntime.preflight_error = OciRuntimeUnavailableError(
        "dedicated task UID security probe failed"
    )

    with pytest.raises(JobEnvironmentPreflightError, match="security probe"):
        ControlJobEnvironment.preflight()


def test_rejects_a_task_without_prebuilt_image(tmp_path: Path) -> None:
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    trial_dir = tmp_path / "trial"
    trial_dir.mkdir()

    with pytest.raises(JobEnvironmentPreflightError, match="prebuilt task image"):
        ControlJobEnvironment(
            environment_dir=environment_dir,
            environment_name="isolated-job",
            session_id="test-session",
            trial_paths=TrialPaths(trial_dir),
            task_env_config=EnvironmentConfig(),
            control_max_command_seconds=5,
            control_max_transfer_bytes=1024,
            control_max_transfer_file_bytes=512,
            control_max_transfer_files=8,
            control_max_transfer_path_depth=4,
            control_max_image_bytes=1024,
            control_max_image_entries=8,
            control_declared_task_image=_DECLARED_TASK_IMAGE,
            control_task_image=_TASK_IMAGE,
        )

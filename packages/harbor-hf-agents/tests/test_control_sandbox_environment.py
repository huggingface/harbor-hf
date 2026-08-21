from __future__ import annotations

import hashlib
import shlex
from pathlib import Path

import pytest
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

from harbor_hf_agents.support import control_sandbox_environment as control


class FakeClient:
    calls: list[tuple[str, str, dict | None]] = []
    idempotency_keys: list[str] = []

    def __init__(self, campaign_id: str, task_id: str) -> None:
        self.campaign_id = campaign_id
        self.task_id = task_id
        self.prefix = f"/api/v1/campaigns/{campaign_id}/tasks/{task_id}"

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        idempotency_key: str,
        **_kwargs,
    ) -> dict:
        self.calls.append((method, path, body))
        self.idempotency_keys.append(idempotency_key)
        if "/prepared-job/trials/" in path:
            return {
                "declared_image": "example.invalid/task:tag",
                "image": f"example.invalid/task@sha256:{'a' * 64}",
            }
        if path.endswith("/sandboxes"):
            return {"sandbox_id": "sandbox-1", "state": "STARTING"}
        if path.endswith("/observe"):
            return {"sandbox_id": "sandbox-1", "state": "RUNNING"}
        if path.endswith("/exec"):
            return {
                "exit_code": 0,
                "stdout": "ok\n",
                "stderr": "",
                "signal": None,
                "timed_out": False,
                "duration_ms": 1,
            }
        if method == "DELETE":
            return {"sandbox_id": "sandbox-1", "state": "STOPPED"}
        raise AssertionError((method, path, body))


@pytest.mark.asyncio
async def test_routes_harbor_operations_through_worker_capability(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    FakeClient.calls.clear()
    FakeClient.idempotency_keys.clear()
    for key, value in {
        "HARBOR_HF_CONTROL_URL": "https://control.example",
        "HARBOR_HF_WORKER_CAPABILITY": "capability",
        "HARBOR_HF_CAMPAIGN_ID": "campaign-1",
        "HARBOR_HF_ACTION_ID": "action-attempt-1",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(control, "_ControlClient", FakeClient)
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    environment = control.ControlSandboxEnvironment(
        environment_dir=environment_dir,
        environment_name="source-task",
        session_id="trial-1__env",
        trial_paths=TrialPaths(tmp_path / "trial"),
        task_env_config=EnvironmentConfig(
            docker_image="example.invalid/task:tag",
            workdir="/app",
        ),
        control_task_id="source-task-trial-1",
        control_max_command_seconds=900,
    )
    monkeypatch.setattr(environment, "_upload_environment_dir_after_start", _noop)

    await environment.start(force_build=False)
    result = await environment.exec(
        "set -o pipefail; printf ok",
        cwd="/app",
        env={"TEST_VALUE": "with space"},
        timeout_sec=30,
        user="harbor-agent",
    )
    await environment.exec("set -o pipefail; printf default", cwd="/app")
    with pytest.raises(ValueError, match="exceeds prepared limit"):
        await environment.exec("printf too-long", timeout_sec=901)
    await environment.stop(delete=True)

    assert result.return_code == 0
    assert result.stdout == "ok\n"
    assert [call[0] for call in FakeClient.calls] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "POST",
        "DELETE",
    ]
    seed = "campaign-1:action-attempt-1:source-task-trial-1:trial-1__env:create:1"
    assert FakeClient.idempotency_keys[1] == (
        f"control-sandbox-{hashlib.sha256(seed.encode()).hexdigest()[:32]}"
    )
    command = FakeClient.calls[3][2]
    assert command is not None
    assert command["command"][:2] == ["/bin/bash", "-lc"]
    runuser_command = shlex.split(command["command"][2])
    assert runuser_command[:6] == [
        "runuser",
        "-u",
        "harbor-agent",
        "--",
        "/bin/bash",
        "-lc",
    ]
    agent_command = shlex.split(runuser_command[6])
    assert agent_command[:4] == [
        "env",
        "TEST_VALUE=with space",
        "/bin/bash",
        "-lc",
    ]
    assert agent_command[4] == "set -o pipefail; printf ok"
    assert "/bin/sh" not in command["command"][2]
    assert command["cwd"] == "/app"
    assert command["timeout_seconds"] == 30
    default_command = FakeClient.calls[4][2]
    assert default_command is not None
    assert default_command["command"][:2] == ["/bin/bash", "-lc"]
    assert "set -o pipefail" in default_command["command"][2]
    assert default_command["timeout_seconds"] == 900


@pytest.mark.asyncio
async def test_waits_for_queued_sandbox_admission_with_one_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class QueuedClient(FakeClient):
        create_calls = 0

        def request(self, method: str, path: str, **kwargs) -> dict:
            if path.endswith("/sandboxes"):
                self.calls.append((method, path, kwargs.get("body")))
                self.idempotency_keys.append(kwargs["idempotency_key"])
                self.__class__.create_calls += 1
                if self.__class__.create_calls == 1:
                    return {
                        "sandbox_id": "sandbox-1",
                        "state": "QUEUED",
                        "limiting_factor": "namespace_sandbox_capacity",
                        "not_before": None,
                    }
                return {"sandbox_id": "sandbox-1", "state": "STARTING"}
            return super().request(method, path, **kwargs)

    FakeClient.calls.clear()
    FakeClient.idempotency_keys.clear()
    QueuedClient.create_calls = 0
    for key, value in {
        "HARBOR_HF_CONTROL_URL": "https://control.example",
        "HARBOR_HF_WORKER_CAPABILITY": "capability",
        "HARBOR_HF_CAMPAIGN_ID": "campaign-1",
        "HARBOR_HF_ACTION_ID": "action-attempt-1",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(control, "_ControlClient", QueuedClient)
    monkeypatch.setattr(control.asyncio, "sleep", _noop_sleep)
    environment_dir = tmp_path / "environment"
    environment_dir.mkdir()
    environment = control.ControlSandboxEnvironment(
        environment_dir=environment_dir,
        environment_name="source-task",
        session_id="trial-1__env",
        trial_paths=TrialPaths(tmp_path / "trial"),
        task_env_config=EnvironmentConfig(
            docker_image="example.invalid/task:tag",
            workdir="/app",
        ),
        control_task_id="source-task-trial-1",
        control_max_command_seconds=900,
    )
    monkeypatch.setattr(environment, "_upload_environment_dir_after_start", _noop)

    await environment.start(force_build=False)

    create_keys = [
        key
        for (method, path, _body), key in zip(
            FakeClient.calls, FakeClient.idempotency_keys, strict=True
        )
        if method == "POST" and path.endswith("/sandboxes")
    ]
    assert len(create_keys) == 2
    assert len(set(create_keys)) == 1


async def _noop() -> None:
    return None


async def _noop_sleep(_delay: float) -> None:
    return None


def test_preflight_rejects_broad_hf_token(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in {
        "HARBOR_HF_CONTROL_URL": "https://control.example",
        "HARBOR_HF_WORKER_CAPABILITY": "capability",
        "HARBOR_HF_CAMPAIGN_ID": "campaign-1",
        "HARBOR_HF_ACTION_ID": "action-attempt-1",
        "HF_TOKEN": "broad-token",
    }.items():
        monkeypatch.setenv(key, value)

    with pytest.raises(RuntimeError, match="must not receive HF_TOKEN"):
        control.ControlSandboxEnvironment.preflight()

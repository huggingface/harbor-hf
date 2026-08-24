from __future__ import annotations

import inspect
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from harbor_hf_agents.support import hf_inference_bridge as bridge
from harbor_hf_agents.support import job_inference_route as route


class RecordingAgent:
    def __init__(self) -> None:
        self.agent_commands: list[str] = []
        self.root_commands: list[str] = []

    async def exec_as_agent(self, _environment: object, *, command: str) -> None:
        self.agent_commands.append(command)

    async def exec_as_root(
        self,
        _environment: object,
        *,
        command: str,
        env: dict[str, str] | None = None,
    ) -> None:
        del env
        self.root_commands.append(command)


@pytest.mark.asyncio
async def test_agent_cleanup_quiesces_tasks_before_verifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class Environment:
        async def quiesce(self) -> None:
            events.append("quiesced")

    async def stop_bridge(_agent: object, _environment: object) -> None:
        events.append("bridge-stopped")

    monkeypatch.setattr(route, "ControlJobEnvironment", Environment)
    monkeypatch.setattr(route, "hf_inference_bridge_is_active", lambda _agent: True)
    monkeypatch.setattr(route, "stop_hf_inference_bridge", stop_bridge)

    @route.with_job_inference_bridge_cleanup
    async def run(
        _agent: object,
        _instruction: str,
        _environment: object,
        _context: object,
    ) -> None:
        events.append("agent-finished")

    await run(object(), "solve", Environment(), object())  # type: ignore[arg-type]

    assert events == ["agent-finished", "bridge-stopped", "quiesced"]


def test_job_route_loader_never_executes_inside_task_rootfs() -> None:
    source = inspect.getsource(route.use_job_inference_route)
    loader_source = inspect.getsource(route._load_job_route)

    assert "exec_as_root" not in source
    assert "json.load" in loader_source
    assert "O_NOFOLLOW" in loader_source


@pytest.mark.skipif(
    sys.platform != "linux" or os.geteuid() != 0,
    reason="requires root Linux file ownership",
)
@pytest.mark.asyncio
async def test_job_route_is_read_by_trusted_host_python(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    route_path = tmp_path / "route.json"
    route_path.write_text(
        json.dumps(
            {
                "schema_version": "v1",
                "api": "chat-completions",
                "base_url": "http://127.0.0.1:18080/v1",
                "api_key": "harbor-local-inference-bridge",
                "model": "locked-model",
            }
        ),
        encoding="utf-8",
    )
    route_path.chmod(0o644)
    monkeypatch.setattr(route, "_JOB_ROUTE_PATH", route_path)
    monkeypatch.setattr(route, "_job_bridge_pid", lambda: 123)
    agent = RecordingAgent()
    environment = SimpleNamespace()
    target: dict[str, str] = {}

    loaded = await route.use_job_inference_route(
        agent,  # type: ignore[arg-type]
        environment,  # type: ignore[arg-type]
        target,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        api="chat-completions",
        allowed_model="locked-model",
    )

    assert loaded is True
    assert target == {
        "OPENAI_BASE_URL": "http://127.0.0.1:18080/v1",
        "OPENAI_API_KEY": "harbor-local-inference-bridge",
    }
    assert agent.root_commands == []
    assert len(agent.agent_commands) == 1
    assert "/proc/123/environ" in agent.agent_commands[0]
    assert "CapBnd" in agent.agent_commands[0]


@pytest.mark.asyncio
async def test_job_bridge_stop_kills_host_before_copying_log(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []
    log = tmp_path / "bridge.log"
    log.write_text("bridge log", encoding="utf-8")
    monkeypatch.setattr(bridge, "_JOB_BRIDGE_LOG", log)
    monkeypatch.setattr(
        bridge,
        "_stop_job_root_bridge",
        lambda: events.append("stopped"),
    )
    agent = RecordingAgent()
    bridge.mark_hf_inference_bridge_active(
        agent,  # type: ignore[arg-type]
        kind="job",
    )

    class Environment:
        async def upload_file(self, source: Path, target: str) -> None:
            assert source == log
            assert target == "/logs/agent/hf-inference-bridge.log"
            events.append("copied")

    await bridge.stop_hf_inference_bridge(
        agent,  # type: ignore[arg-type]
        Environment(),  # type: ignore[arg-type]
    )

    assert events == ["stopped", "copied"]
    assert agent.root_commands == []
    assert bridge.hf_inference_bridge_is_active(agent) is False  # type: ignore[arg-type]


@pytest.mark.skipif(os.geteuid() == 0, reason="requires a non-root test owner")
def test_job_bridge_handle_rejects_non_root_owner(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    handle_path = tmp_path / "handle.json"
    handle_path.write_text(
        json.dumps({"schema_version": "v1", "pid": 2, "start_time": 1}) + "\n",
        encoding="utf-8",
    )
    handle_path.chmod(0o600)
    monkeypatch.setattr(bridge, "_JOB_BRIDGE_HANDLE", handle_path)

    with pytest.raises(RuntimeError, match="not root-owned"):
        bridge._read_job_bridge_handle()


@pytest.mark.skipif(
    sys.platform != "linux" or not hasattr(os, "pidfd_open"),
    reason="requires Linux pidfds",
)
def test_linux_host_bridge_stop_kills_and_awaits_exact_pid(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    process = subprocess.Popen(["sleep", "30"])
    route_path = tmp_path / "route.json"
    route_path.write_text("{}\n", encoding="utf-8")
    handle_path = tmp_path / "handle.json"
    handle_path.write_text(
        json.dumps(
            {
                "schema_version": "v1",
                "pid": process.pid,
                "start_time": bridge._process_start_time(process.pid),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    handle_path.chmod(0o600)
    monkeypatch.setattr(bridge, "_JOB_BRIDGE_ROUTE", route_path)
    monkeypatch.setattr(bridge, "_JOB_BRIDGE_HANDLE", handle_path)
    monkeypatch.setattr(
        bridge,
        "_read_job_bridge_handle",
        lambda: (process.pid, bridge._process_start_time(process.pid)),
    )
    try:
        bridge._stop_job_root_bridge()
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)

    assert process.returncode == -9
    assert not route_path.exists()
    assert not handle_path.exists()
    assert stat.S_IMODE(tmp_path.stat().st_mode) & 0o700 == 0o700

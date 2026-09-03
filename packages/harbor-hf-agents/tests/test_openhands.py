"""Unit tests for OpenHands direct inference."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.openhands.agent import OpenHandsAgent
from harbor_hf_agents.support.control_job_environment import ControlJobEnvironment


@pytest.fixture(autouse=True)
def no_ambient_inference(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("LLM_API_KEY", "LLM_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"):
        monkeypatch.delenv(name, raising=False)


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "openhands.core.main" in call.kwargs["command"]:
            return call
    raise AssertionError("No OpenHands run command found in exec calls")


@pytest.mark.asyncio
async def test_openai_settings_are_mapped_to_harness_aliases(temp_dir) -> None:
    agent = OpenHandsAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.6.0",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
        },
    )
    mock_env = AsyncMock(spec=ControlJobEnvironment)
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "solve the task" in run_call.kwargs["command"]
    assert run_call.kwargs["env"]["LLM_BASE_URL"] == "https://router.huggingface.co/v1"
    assert run_call.kwargs["env"]["LLM_API_KEY"] == "direct-token"
    assert run_call.kwargs["env"]["TMUX_TMPDIR"] == "/tmp/harbor-agent-home/.tmux"
    tmux_call = mock_env.start_background.await_args
    assert "exec tmux -D -f /dev/null" in tmux_call.args[0]
    assert tmux_call.kwargs == {
        "env": {"TMUX_TMPDIR": "/tmp/harbor-agent-home/.tmux"},
        "user": "harbor-agent",
    }
    assert any(
        "tmux server did not become ready" in call.kwargs["command"]
        for call in mock_env.exec.call_args_list
    )


@pytest.mark.asyncio
async def test_missing_direct_settings_fail(temp_dir) -> None:
    agent = OpenHandsAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.6.0",
    )
    mock_env = AsyncMock(spec=ControlJobEnvironment)
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="inference base URL"):
        await agent.run("solve the task", mock_env, AgentContext())

    mock_env.quiesce.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_install_creates_isolated_agent_user(temp_dir) -> None:
    agent = OpenHandsAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.6.0",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(mock_env)

    first = mock_env.exec.call_args_list[0]
    assert "passwd util-linux" in first.kwargs["command"]
    commands = [call.kwargs["command"] for call in mock_env.exec.call_args_list]
    useradd_at = next(
        index for index, command in enumerate(commands) if "useradd" in command
    )
    chown_at = next(
        index
        for index, command in enumerate(commands)
        if "chown harbor-agent:harbor-agent /opt/openhands-venv" in command
    )
    assert useradd_at < chown_at
    assert all("tmux new-session" not in command for command in commands)
    assert any(
        "openhands-ai==1.6.0" in call.kwargs["command"]
        for call in mock_env.exec.call_args_list
    )

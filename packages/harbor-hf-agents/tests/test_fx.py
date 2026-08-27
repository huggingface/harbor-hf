"""Unit tests for the FX job inference wrapper."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.fx.agent import FxAgent

_ROUTE = "harbor_hf_agents.support.job_chat_completions.use_job_inference_route"


@pytest.fixture(autouse=True)
def no_job_inference_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_ROUTE, AsyncMock(return_value=False))


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "fx ask" in call.kwargs["command"]:
            return call
    raise AssertionError("No fx run command found in exec calls")


@pytest.mark.asyncio
async def test_job_route_injects_loopback_env(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def use_route(_agent, _environment, env, **kwargs):
        assert kwargs["base_url_key"] == "FX_GATEWAY_BASE_URL"
        assert kwargs["api_key_key"] == "AI_GATEWAY_API_KEY"
        assert kwargs["api"] == "chat-completions"
        assert kwargs["allowed_model"] == "openai/gpt-oss-20b:together"
        env["FX_GATEWAY_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["AI_GATEWAY_API_KEY"] = "harbor-local-inference-bridge"
        return True

    monkeypatch.setattr(_ROUTE, use_route)
    monkeypatch.delenv("AI_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("FX_GATEWAY_BASE_URL", raising=False)
    monkeypatch.delenv("AI_GATEWAY_BASE_URL", raising=False)
    agent = FxAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.0.5",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "solve the task" in run_call.kwargs["command"]
    assert "fx ask --yolo --json --" in run_call.kwargs["command"]
    env = run_call.kwargs["env"]
    assert env["FX_GATEWAY_BASE_URL"] == "http://127.0.0.1:18080/v1"
    assert "AI_GATEWAY_BASE_URL" not in env
    assert env["AI_GATEWAY_API_KEY"] == "harbor-local-inference-bridge"
    assert env["OPENAI_BASE_URL"] == "http://127.0.0.1:18080/v1"
    assert env["OPENAI_API_KEY"] == "harbor-local-inference-bridge"
    assert env["FX_MODEL"] == "openai/gpt-oss-20b:together"


@pytest.mark.asyncio
async def test_missing_job_route_fails(temp_dir) -> None:
    agent = FxAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.0.5",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="Job inference route"):
        await agent.run("solve the task", mock_env, AgentContext())


@pytest.mark.asyncio
async def test_install_creates_isolated_agent_user(temp_dir) -> None:
    agent = FxAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.0.5",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(mock_env)

    first = mock_env.exec.call_args_list[0]
    assert "tmux" in first.kwargs["command"]
    commands = "\n".join(
        call.kwargs["command"] for call in mock_env.exec.call_args_list
    )
    assert "https://fx.sh/setup.sh" in commands
    assert "v0.0.5" in commands

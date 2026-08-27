"""Unit tests for the OpenCode job inference wrapper."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.opencode.agent import OpenCodeAgent

_ROUTE = "harbor_hf_agents.support.job_chat_completions.use_job_inference_route"


@pytest.fixture(autouse=True)
def no_job_inference_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_ROUTE, AsyncMock(return_value=False))


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "opencode --model=" in call.kwargs["command"]:
            return call
    raise AssertionError("No opencode run command found in exec calls")


def _config_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "opencode.json" in call.kwargs["command"]:
            return call
    raise AssertionError("No opencode config command found in exec calls")


@pytest.mark.asyncio
async def test_job_route_injects_loopback_env(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stop_bridge = AsyncMock()

    async def use_route(_agent, _environment, env, **kwargs):
        assert kwargs["base_url_key"] == "OPENAI_BASE_URL"
        assert kwargs["api_key_key"] == "OPENAI_API_KEY"
        assert kwargs["api"] == "chat-completions"
        assert kwargs["allowed_model"] == "openai/gpt-oss-20b:together"
        env["OPENAI_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["OPENAI_API_KEY"] = "harbor-local-inference-bridge"
        _agent._harbor_hf_inference_bridge_active = True
        return True

    monkeypatch.setattr(_ROUTE, use_route)
    monkeypatch.setattr(
        "harbor_hf_agents.support.job_inference_route.stop_hf_inference_bridge",
        stop_bridge,
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.18.20",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "--model=openai/openai/gpt-oss-20b:together" in run_call.kwargs["command"]
    assert "solve the task" in run_call.kwargs["command"]
    assert run_call.kwargs["env"]["OPENAI_BASE_URL"] == "http://127.0.0.1:18080/v1"
    assert run_call.kwargs["env"]["OPENAI_API_KEY"] == "harbor-local-inference-bridge"
    provider_config = agent._opencode_config["provider"]["openai"]
    assert provider_config == {
        "npm": "@ai-sdk/openai-compatible",
        "models": {"openai/gpt-oss-20b:together": {}},
        "options": {"baseURL": "http://127.0.0.1:18080/v1"},
    }
    config_call = _config_call(mock_env.exec.call_args_list)
    assert "@ai-sdk/openai-compatible" in config_call.kwargs["command"]
    assert "http://127.0.0.1:18080/v1" in config_call.kwargs["command"]
    assert "openai/gpt-oss-20b:together" in config_call.kwargs["command"]
    stop_bridge.assert_awaited_once_with(agent, mock_env)


@pytest.mark.asyncio
async def test_job_route_preserves_unrelated_opencode_config(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stop_bridge = AsyncMock()

    async def use_route(_agent, _environment, env, **kwargs):
        assert kwargs["api"] == "chat-completions"
        assert kwargs["allowed_model"] == "acme/model-v2:vendor"
        env["OPENAI_BASE_URL"] = "http://127.0.0.1:18081/v1"
        env["OPENAI_API_KEY"] = "harbor-local-inference-bridge"
        _agent._harbor_hf_inference_bridge_active = True
        return True

    monkeypatch.setattr(_ROUTE, use_route)
    monkeypatch.setattr(
        "harbor_hf_agents.support.job_inference_route.stop_hf_inference_bridge",
        stop_bridge,
    )
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="gateway/acme/model-v2:vendor",
        version="1.18.20",
        opencode_config={
            "provider": {
                "gateway": {
                    "npm": "wrong-driver",
                    "name": "Existing provider",
                    "models": {
                        "acme/model-v2:vendor": {"name": "Wrong locked model"},
                        "other/model": {"name": "Other model"},
                    },
                    "options": {
                        "baseURL": "https://wrong.invalid/v1",
                        "timeout": 1234,
                    },
                }
            },
            "experimental": {"continue_loop_on_deny": True},
        },
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve another task", mock_env, AgentContext())

    provider_config = agent._opencode_config["provider"]["gateway"]
    assert provider_config == {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Existing provider",
        "models": {
            "acme/model-v2:vendor": {},
            "other/model": {"name": "Other model"},
        },
        "options": {
            "baseURL": "http://127.0.0.1:18081/v1",
            "timeout": 1234,
        },
    }
    assert agent._opencode_config["experimental"] == {"continue_loop_on_deny": True}
    run_call = _run_call(mock_env.exec.call_args_list)
    assert "--model=gateway/acme/model-v2:vendor" in run_call.kwargs["command"]
    config_call = _config_call(mock_env.exec.call_args_list)
    assert "@ai-sdk/openai-compatible" in config_call.kwargs["command"]
    assert "http://127.0.0.1:18081/v1" in config_call.kwargs["command"]
    assert "https://wrong.invalid/v1" not in config_call.kwargs["command"]
    stop_bridge.assert_awaited_once_with(agent, mock_env)


@pytest.mark.asyncio
async def test_missing_job_route_fails(temp_dir) -> None:
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.18.20",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="Job inference route"):
        await agent.run("solve the task", mock_env, AgentContext())


@pytest.mark.asyncio
async def test_install_creates_isolated_agent_user(temp_dir) -> None:
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.18.20",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(mock_env)

    first = mock_env.exec.call_args_list[0]
    assert "passwd util-linux" in first.kwargs["command"]
    assert any(
        "opencode-ai@1.18.20" in call.kwargs["command"]
        for call in mock_env.exec.call_args_list
    )

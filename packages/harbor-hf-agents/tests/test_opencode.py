"""Unit tests for OpenCode direct inference."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.opencode.agent import OpenCodeAgent


@pytest.fixture(autouse=True)
def no_ambient_inference(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)


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
async def test_direct_settings_configure_provider(temp_dir) -> None:
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.18.20",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
        },
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "--model=openai/openai/gpt-oss-20b:together" in run_call.kwargs["command"]
    assert "solve the task" in run_call.kwargs["command"]
    assert (
        run_call.kwargs["env"]["OPENAI_BASE_URL"] == "https://router.huggingface.co/v1"
    )
    assert run_call.kwargs["env"]["OPENAI_API_KEY"] == "direct-token"
    provider_config = agent._opencode_config["provider"]["openai"]
    assert provider_config == {
        "npm": "@ai-sdk/openai-compatible",
        "models": {"openai/gpt-oss-20b:together": {}},
        "options": {"baseURL": "https://router.huggingface.co/v1"},
    }
    config_call = _config_call(mock_env.exec.call_args_list)
    assert "@ai-sdk/openai-compatible" in config_call.kwargs["command"]
    assert "https://router.huggingface.co/v1" in config_call.kwargs["command"]
    assert "openai/gpt-oss-20b:together" in config_call.kwargs["command"]


@pytest.mark.asyncio
async def test_direct_settings_preserve_unrelated_opencode_config(temp_dir) -> None:
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="gateway/acme/model-v2:vendor",
        version="1.18.20",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
        },
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
            "baseURL": "https://router.huggingface.co/v1",
            "timeout": 1234,
        },
    }
    assert agent._opencode_config["experimental"] == {"continue_loop_on_deny": True}
    run_call = _run_call(mock_env.exec.call_args_list)
    assert "--model=gateway/acme/model-v2:vendor" in run_call.kwargs["command"]
    config_call = _config_call(mock_env.exec.call_args_list)
    assert "@ai-sdk/openai-compatible" in config_call.kwargs["command"]
    assert "https://router.huggingface.co/v1" in config_call.kwargs["command"]
    assert "https://wrong.invalid/v1" not in config_call.kwargs["command"]


@pytest.mark.asyncio
async def test_missing_direct_settings_fail(temp_dir) -> None:
    agent = OpenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="1.18.20",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="inference base URL"):
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

"""Unit tests for Kimi Code direct inference."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.kimi_code.agent import KimiCodeAgent


@pytest.fixture(autouse=True)
def no_ambient_inference(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "KIMI_MODEL_API_KEY",
        "KIMI_MODEL_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "HARBOR_HF_MAX_OUTPUT_TOKENS",
    ):
        monkeypatch.delenv(name, raising=False)


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "kimi " in call.kwargs["command"] and "--prompt" in call.kwargs["command"]:
            return call
    raise AssertionError("No kimi run command found in exec calls")


@pytest.mark.asyncio
async def test_openai_settings_are_mapped_to_kimi_aliases(temp_dir) -> None:
    agent = KimiCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.38.0",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "solve the task" in run_call.kwargs["env"].values()
    assert (
        run_call.kwargs["env"]["KIMI_MODEL_BASE_URL"]
        == "https://router.huggingface.co/v1"
    )
    assert run_call.kwargs["env"]["KIMI_MODEL_API_KEY"] == "direct-token"
    assert run_call.kwargs["env"]["KIMI_MODEL_NAME"] == "openai/gpt-oss-20b:together"
    assert run_call.kwargs["env"]["KIMI_MODEL_MAX_COMPLETION_TOKENS"] == "32768"


@pytest.mark.asyncio
async def test_missing_direct_settings_fail(temp_dir) -> None:
    agent = KimiCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.38.0",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="inference base URL"):
        await agent.run("solve the task", mock_env, AgentContext())


@pytest.mark.asyncio
async def test_install_creates_isolated_agent_user(temp_dir) -> None:
    agent = KimiCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.38.0",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(mock_env)

    first = mock_env.exec.call_args_list[0]
    assert "passwd util-linux" in first.kwargs["command"]
    assert any(
        "@moonshot-ai/kimi-code@0.38.0" in call.kwargs["command"]
        for call in mock_env.exec.call_args_list
    )

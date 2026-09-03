"""Unit tests for Qwen Code direct inference."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.qwen_code.agent import QwenCodeAgent


@pytest.fixture(autouse=True)
def no_ambient_inference(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "qwen --yolo" in call.kwargs["command"]:
            return call
    raise AssertionError("No qwen run command found in exec calls")


@pytest.mark.asyncio
async def test_direct_settings_are_injected(temp_dir) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.21.15",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
        },
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "solve the task" in run_call.kwargs["command"]
    assert (
        run_call.kwargs["env"]["OPENAI_BASE_URL"] == "https://router.huggingface.co/v1"
    )
    assert run_call.kwargs["env"]["OPENAI_API_KEY"] == "direct-token"
    assert run_call.kwargs["env"]["OPENAI_MODEL"] == "openai/gpt-oss-20b:together"


@pytest.mark.asyncio
async def test_missing_direct_settings_fail(temp_dir) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.21.15",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="inference base URL"):
        await agent.run("solve the task", mock_env, AgentContext())


@pytest.mark.asyncio
async def test_install_creates_isolated_agent_user(temp_dir) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.21.15",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(mock_env)

    first = mock_env.exec.call_args_list[0]
    assert "passwd util-linux" in first.kwargs["command"]
    assert any(
        "@qwen-code/qwen-code@0.21.15" in call.kwargs["command"]
        for call in mock_env.exec.call_args_list
    )

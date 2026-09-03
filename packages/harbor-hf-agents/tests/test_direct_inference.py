"""Tests for shared direct OpenAI-compatible inference configuration."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.qwen_code.agent import QwenCodeAgent
from harbor_hf_agents.support.direct_inference import (
    MAX_OUTPUT_TOKENS_ENV,
    allowed_model_id,
    max_output_tokens,
)


def test_allowed_model_id_strips_the_provider_prefix() -> None:
    assert allowed_model_id("openai/gpt-oss-20b:together") == "gpt-oss-20b:together"


def test_allowed_model_id_rejects_a_bare_name() -> None:
    with pytest.raises(ValueError, match="provider/model_name"):
        allowed_model_id("gpt-oss-20b")


def test_reads_direct_inference_output_limit() -> None:
    assert max_output_tokens("32768") == 32768


@pytest.mark.asyncio
async def test_plugin_without_install_environment_stays_unchanged(temp_dir) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.21.15",
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(environment)

    install_call = next(
        call
        for call in environment.exec.call_args_list
        if "@qwen-code/qwen-code@0.21.15" in call.kwargs["command"]
    )
    assert "UV_PYTHON" not in install_call.kwargs["env"]


@pytest.mark.asyncio
async def test_exec_as_agent_forwards_working_directory_and_timeout(temp_dir) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.21.15",
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.exec_as_agent(
        environment,
        command="true",
        cwd="/app/work",
        timeout_sec=123,
    )

    assert environment.exec.await_args.kwargs["cwd"] == "/app/work"
    assert environment.exec.await_args.kwargs["timeout_sec"] == 123


@pytest.mark.parametrize("value", [None, "", "0", "-1", "invalid"])
def test_rejects_invalid_direct_inference_output_limit(
    value: str | None,
) -> None:
    with pytest.raises(RuntimeError, match="positive integer|required"):
        max_output_tokens(value)


@pytest.mark.asyncio
async def test_resolves_settings_from_harbor_agent_environment(temp_dir) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            MAX_OUTPUT_TOKENS_ENV: "32768",
        },
    )

    assert await agent.prepare_inference_env() == {
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
        "OPENAI_API_KEY": "direct-token",
        MAX_OUTPUT_TOKENS_ENV: "32768",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("extra_env", "message"),
    [
        ({"OPENAI_API_KEY": "direct-token"}, "base URL"),
        ({"OPENAI_BASE_URL": "https://router.huggingface.co/v1"}, "API key"),
    ],
)
async def test_missing_direct_setting_fails_closed(
    temp_dir,
    extra_env: dict[str, str],
    message: str,
) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        extra_env=extra_env,
    )

    with pytest.raises(RuntimeError, match=message):
        await agent.run("solve", AsyncMock(), AgentContext())


@pytest.mark.asyncio
async def test_failed_post_prepare_hook_clears_sensitive_state(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = QwenCodeAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
        },
    )
    monkeypatch.setattr(
        agent,
        "after_inference_prepared",
        AsyncMock(side_effect=RuntimeError("hook failed")),
    )

    with pytest.raises(RuntimeError, match="hook failed"):
        await agent.run("solve", AsyncMock(), AgentContext())

    assert agent._inference_env is None

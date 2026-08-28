"""Tests for the shared Chat Completions loopback wrapper."""

from unittest.mock import AsyncMock

import pytest

from harbor_hf_agents.qwen_code.agent import QwenCodeAgent
from harbor_hf_agents.support.job_chat_completions import (
    allowed_model_id,
    inference_max_output_tokens,
)


def test_allowed_model_id_strips_the_provider_prefix() -> None:
    assert allowed_model_id("openai/gpt-oss-20b:together") == "gpt-oss-20b:together"


def test_allowed_model_id_rejects_a_bare_name() -> None:
    with pytest.raises(ValueError, match="provider/model_name"):
        allowed_model_id("gpt-oss-20b")


def test_reads_locked_inference_output_limit() -> None:
    assert inference_max_output_tokens("32768") == 32768


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
def test_rejects_invalid_inference_output_limit(
    value: str | None,
) -> None:
    with pytest.raises(RuntimeError, match="positive integer|required"):
        inference_max_output_tokens(value)

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.fx.agent import FxAgent
from harbor_hf_agents.support.fx_inference_bridge import (
    FxInferenceUsage,
    _bridge_script,
    _fx_gateway_request,
    _fx_gateway_response,
    _parse_usage,
    _validate_upstream,
)


def test_fx_request_translates_text_and_tools() -> None:
    translated = _fx_gateway_request(
        {
            "prompt": [
                {"role": "system", "content": "Be concise."},
                {"role": "user", "content": "Inspect the repository."},
            ],
            "maxOutputTokens": 512,
            "tools": [
                {
                    "type": "function",
                    "name": "read_file",
                    "description": "Read a file.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                    },
                }
            ],
            "toolChoice": {"type": "auto"},
        },
        "Qwen/model:provider",
        32768,
    )

    assert translated["model"] == "Qwen/model:provider"
    assert translated["max_tokens"] == 512
    assert translated["stream"] is False
    assert translated["messages"] == [
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "Inspect the repository."},
    ]
    assert translated["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                },
            },
        }
    ]


def test_fx_response_translates_text_tool_calls_and_usage() -> None:
    response = _fx_gateway_response(
        b'{"choices":[{"message":{"content":"Done.","tool_calls":['
        b'{"id":"call-1","type":"function","function":{"name":"read_file",'
        b'"arguments":"{\\"path\\":\\"README.md\\"}"}}]},'
        b'"finish_reason":"tool_calls"}],'
        b'"usage":{"prompt_tokens":12,"completion_tokens":7}}'
    )

    assert b'"type":"text-delta"' in response
    assert b'"delta":"Done."' in response
    assert b'"toolName":"read_file"' in response
    assert b'"total":12' in response
    assert response.endswith(b"data: [DONE]\n\n")


def test_fx_bridge_accepts_only_the_locked_router() -> None:
    _validate_upstream("https://router.huggingface.co/v1")
    with pytest.raises(RuntimeError, match="locked Hugging Face router"):
        _validate_upstream("https://example.com/v1")


def test_fx_bridge_script_is_self_contained() -> None:
    compile(_bridge_script(), "fx-bridge", "exec")


def test_parses_only_valid_usage_records() -> None:
    assert _parse_usage(
        '{"schema_version":"v1","requests":2,"input_tokens":10,"output_tokens":4}\n'
    ) == FxInferenceUsage(requests=2, input_tokens=10, output_tokens=4)
    assert _parse_usage('{"schema_version":"v1","requests":true}\n') is None


@pytest.mark.asyncio
async def test_install_uses_pinned_github_artifact(tmp_path: Path) -> None:
    agent = FxAgent(
        logs_dir=tmp_path,
        model_name="openai/Qwen/model:provider",
        version="0.0.5",
        reasoning_effort="auto",
    )
    environment = AsyncMock()
    agent.exec_as_root = AsyncMock()
    agent.exec_as_agent = AsyncMock()

    await agent.install(environment)

    root_commands = [
        call.kwargs["command"] for call in agent.exec_as_root.call_args_list
    ]
    agent_commands = [
        call.kwargs["command"] for call in agent.exec_as_agent.call_args_list
    ]
    assert any(
        "Acquire::Check-Valid-Until=false" in command for command in root_commands
    )
    assert any(
        "github.com/vercel-labs/fx/releases/download/v0.0.5" in command
        for command in agent_commands
    )
    assert any(
        "d5639d173267774aa8228a474baf619a" in command for command in agent_commands
    )
    assert any("settings.json" in command for command in agent_commands)


@pytest.mark.asyncio
async def test_run_uses_local_gateway_and_records_usage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = FxAgent(
        logs_dir=tmp_path,
        model_name="openai/Qwen/model:provider",
        version="0.0.5",
        reasoning_effort="auto",
        extra_env={"OPENAI_BASE_URL": "https://router.huggingface.co/v1"},
    )
    environment = AsyncMock()
    agent.exec_as_agent = AsyncMock()
    usage = FxInferenceUsage(requests=1, input_tokens=17, output_tokens=9)
    start = AsyncMock()
    stop = AsyncMock(return_value=usage)
    monkeypatch.setattr("harbor_hf_agents.fx.agent.start_fx_bridge", start)
    monkeypatch.setattr("harbor_hf_agents.fx.agent.stop_fx_bridge", stop)
    monkeypatch.setenv("HF_INFERENCE_TOKEN", "test-inference-token")
    context = AgentContext()

    await agent.run("Inspect the repository.", environment, context)

    start.assert_awaited_once()
    stop.assert_awaited_once()
    command = agent.exec_as_agent.await_args.kwargs["command"]
    env = agent.exec_as_agent.await_args.kwargs["env"]
    assert "fx ask --yolo --json --" in command
    assert env["FX_GATEWAY_CHAT_URL"].endswith("/v3/ai/language-model")
    assert env["FX_MODEL"] == "Qwen/model:provider"
    assert context.n_input_tokens == 17
    assert context.n_output_tokens == 9

"""Unit tests for the DeepSeek Harness agent."""

import json
from unittest.mock import AsyncMock

import pytest
import yaml
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.dsh import agent as dsh_agent
from harbor_hf_agents.dsh.agent import DshAgent


@pytest.fixture(autouse=True)
def no_sandbox_inference_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        dsh_agent,
        "use_sandbox_inference_route",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        dsh_agent,
        "prepare_hf_inference_bridge",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        dsh_agent,
        "stop_hf_inference_bridge",
        AsyncMock(),
    )


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "dsh --profile headless" in call.kwargs["command"]:
            return call
    raise AssertionError("No dsh run command found in exec calls")


@pytest.mark.asyncio
async def test_sandbox_route_uses_dsh_env(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def use_route(_agent, _environment, env, **kwargs):
        assert kwargs["base_url_key"] == "DSH_BASE_URL"
        assert kwargs["api_key_key"] == "DSH_API_KEY"
        env["DSH_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["DSH_API_KEY"] = "harbor-local-inference-bridge"
        return True

    monkeypatch.setattr(dsh_agent, "use_sandbox_inference_route", use_route)
    agent = DshAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.1.0-rc.7",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
    mock_env.capabilities.mounted = True

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "dsh --profile headless" in run_call.kwargs["command"]
    assert "solve the task" in run_call.kwargs["command"]
    assert run_call.kwargs["env"]["DSH_BASE_URL"] == "http://127.0.0.1:18080/v1"
    assert run_call.kwargs["env"]["DSH_API_KEY"] == "harbor-local-inference-bridge"
    assert run_call.kwargs["env"]["DSH_TELEMETRY_DISABLED"] == "1"
    settings = yaml.safe_load((temp_dir / "settings.yaml").read_text())
    route = settings["llm-pi-ai"]["providers"]["harbor"]
    assert route["baseURL"] == "http://127.0.0.1:18080/v1"
    assert route["models"][0]["id"] == "openai/gpt-oss-20b:together"
    patch = yaml.safe_load((temp_dir / "cordis.patch.yml").read_text())
    assert patch[0]["config"]["model"] == "openai/gpt-oss-20b:together"


@pytest.mark.asyncio
async def test_copies_openai_route_when_sandbox_file_is_absent(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example/v1")
    agent = DshAgent(
        logs_dir=temp_dir,
        model_name="openai/deepseek-ai/DeepSeek-V4-Flash-0731:together",
        thinking_format="deepseek",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
    mock_env.capabilities.mounted = True

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert run_call.kwargs["env"]["DSH_BASE_URL"] == "https://proxy.example/v1"
    assert run_call.kwargs["env"]["DSH_API_KEY"] == "sk-test"
    settings = yaml.safe_load((temp_dir / "settings.yaml").read_text())
    assert (
        settings["llm-pi-ai"]["providers"]["harbor"]["compat"]["thinkingFormat"]
        == "deepseek"
    )


def test_converts_session_jsonl_to_trajectory(temp_dir) -> None:
    session = temp_dir / "dsh-sessions" / "sess-1" / "session.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text(
        "\n".join(
            [
                json.dumps({"type": "session", "id": "sess-1"}),
                json.dumps(
                    {
                        "type": "assistant",
                        "time": 1_700_000_000_000,
                        "data": {
                            "content": [
                                {"type": "text", "text": "calling bash"},
                                {
                                    "type": "tool-call",
                                    "id": "call-1",
                                    "name": "bash",
                                    "arguments": '{"command":"pwd"}',
                                },
                            ],
                            "usage": {
                                "inputTokens": 10,
                                "outputTokens": 2,
                                "cacheReadTokens": 3,
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "tool/result",
                        "data": {
                            "id": "call-1",
                            "content": [{"type": "text", "text": "/app"}],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "time": 1_700_000_001_000,
                        "data": {
                            "content": [{"type": "text", "text": "done"}],
                            "usage": {"inputTokens": 4, "outputTokens": 1},
                        },
                    }
                ),
            ]
        )
        + "\n"
    )
    agent = DshAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="0.1.0-rc.7",
    )
    trajectory = agent._convert_session()
    assert trajectory is not None
    assert trajectory.agent.name == "dsh"
    assert len(trajectory.steps) == 2
    assert trajectory.steps[0].tool_calls is not None
    assert trajectory.steps[0].tool_calls[0].function_name == "bash"
    assert trajectory.steps[0].observation is not None
    assert trajectory.steps[0].observation.results[0].content == "/app"
    assert trajectory.final_metrics is not None
    assert trajectory.final_metrics.total_prompt_tokens == 17
    assert trajectory.final_metrics.total_completion_tokens == 3


def test_ignores_invalid_session_token_counts() -> None:
    metrics = DshAgent._build_metrics(
        {
            "inputTokens": "10",
            "outputTokens": True,
            "cacheReadTokens": -3,
            "cacheWriteTokens": 2,
        }
    )

    assert metrics is not None
    assert metrics.prompt_tokens == 2
    assert metrics.completion_tokens == 0
    assert metrics.cached_tokens == 0

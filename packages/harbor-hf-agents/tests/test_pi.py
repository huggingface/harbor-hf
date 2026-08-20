"""Unit tests for the PiAgent installed agent."""

import json
import os
from unittest.mock import AsyncMock, patch

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.pi.agent import PiAgent, pi_jsonl_to_atif_trajectory
from harbor_hf_agents.support.provider_outcome import TransientProviderError
from harbor_hf_agents.support.sandbox_inference_route import (
    use_sandbox_inference_route,
)


@pytest.fixture
def temp_dir(tmp_path):
    return tmp_path


def _successful_pi_output() -> str:
    return json.dumps(
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "stop",
                "usage": {"input": 10, "output": 5},
            },
        }
    )


def _exec_result(output: str | None = None) -> AsyncMock:
    return AsyncMock(
        return_code=0,
        stdout=_successful_pi_output() if output is None else output,
        stderr="",
    )


def _exec_with_empty_sandbox_probe(*_args, **kwargs) -> AsyncMock:
    command = kwargs.get("command", "")
    return _exec_result("" if "/run/harbor-hf-inference.json" in command else None)


def test_pi_jsonl_converts_tool_use_to_atif(temp_dir) -> None:
    path = temp_dir / "pi.txt"
    events = [
        {"type": "session", "id": "pi-session"},
        {
            "type": "message_end",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "do it"}],
            },
        },
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "bash",
                        "arguments": {"command": "pwd"},
                    }
                ],
                "usage": {"input": 10, "output": 2, "cacheRead": 3},
            },
        },
        {
            "type": "message_end",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-1",
                "content": [{"type": "text", "text": "/app"}],
            },
        },
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "usage": {"input": 4, "output": 1, "cacheRead": 0},
            },
        },
    ]
    path.write_text("\n".join(json.dumps(event) for event in events) + "\n")

    trajectory = pi_jsonl_to_atif_trajectory(
        path,
        version="0.82.1",
        model_name="openai/org/model",
    )

    assert trajectory is not None
    assert trajectory.session_id == "pi-session"
    assert [step.source for step in trajectory.steps] == ["user", "agent", "agent"]
    assert trajectory.steps[1].tool_calls is not None
    assert trajectory.steps[1].tool_calls[0].function_name == "bash"
    assert trajectory.steps[1].observation is not None
    assert trajectory.steps[1].observation.results[0].content == "/app"
    assert trajectory.final_metrics is not None
    assert trajectory.final_metrics.total_prompt_tokens == 17
    assert trajectory.final_metrics.total_completion_tokens == 3


@pytest.mark.asyncio
async def test_uses_prepared_sandbox_loopback_route() -> None:
    agent = AsyncMock()
    route = {
        "schema_version": "v1",
        "api": "chat-completions",
        "base_url": "http://127.0.0.1:18080/v1",
        "api_key": "harbor-local-inference-bridge",
        "model": "example/model",
    }
    agent.exec_as_root.return_value = AsyncMock(
        return_code=0,
        stdout=json.dumps(route),
        stderr="",
    )
    env: dict[str, str] = {}

    assert await use_sandbox_inference_route(
        agent,
        AsyncMock(),
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        api="chat-completions",
        allowed_model="example/model",
    )
    assert env == {
        "OPENAI_BASE_URL": "http://127.0.0.1:18080/v1",
        "OPENAI_API_KEY": "harbor-local-inference-bridge",
    }
    agent.exec_as_agent.assert_awaited_once()
    assert "cat /proc/$pid/environ" in agent.exec_as_agent.await_args.kwargs["command"]


class TestPiAgent:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("version", "expected_package"),
        [
            (None, "@earendil-works/pi-coding-agent@latest"),
            ("0.73.1", "@mariozechner/pi-coding-agent@0.73.1"),
            ("0.74.0", "@earendil-works/pi-coding-agent@0.74.0"),
        ],
    )
    async def test_install_uses_current_pi_package(
        self, temp_dir, version, expected_package
    ):
        agent = PiAgent(logs_dir=temp_dir, version=version)
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result()

        await agent.install(mock_env)

        install_command = next(
            call.kwargs["command"]
            for call in mock_env.exec.call_args_list
            if "npm install -g" in call.kwargs["command"]
        )
        assert f"npm install -g {expected_package}" in install_command

    @pytest.mark.asyncio
    async def test_run_command_structure(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-5")
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result()
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=False):
            await agent.run("Fix the bug", mock_env, AsyncMock())

        exec_calls = mock_env.exec.call_args_list
        run_cmd = exec_calls[-1].kwargs["command"]
        assert ". ~/.nvm/nvm.sh;" in run_cmd
        assert "--provider anthropic" in run_cmd
        assert "--model claude-sonnet-4-5" in run_cmd
        assert "--print" in run_cmd
        assert "--mode json" in run_cmd
        assert "--session-dir /logs/agent/pi/sessions" in run_cmd
        assert "pi.txt" in run_cmd

    @pytest.mark.asyncio
    async def test_run_no_model(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result()
        with pytest.raises(ValueError, match="provider/model_name"):
            await agent.run("Fix the bug", mock_env, AsyncMock())

    @pytest.mark.asyncio
    async def test_run_no_slash_in_model(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir, model_name="claude-sonnet-4-5")
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result()
        with pytest.raises(ValueError, match="provider/model_name"):
            await agent.run("Fix the bug", mock_env, AsyncMock())

    @pytest.mark.asyncio
    async def test_run_with_any_provider(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir, model_name="my-provider/my-model")
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result()
        await agent.run("Fix the bug", mock_env, AsyncMock())
        run_command = mock_env.exec.call_args_list[-1].kwargs["command"]
        assert "--provider my-provider --model my-model" in run_command

    @pytest.mark.asyncio
    async def test_run_rejects_final_zero_token_rate_limit_and_cleans_up(
        self, temp_dir
    ):
        agent = PiAgent(
            logs_dir=temp_dir,
            model_name="my-provider/my-model",
            models_json={
                "providers": {"my-provider": {"baseUrl": "https://proxy.example/v1"}}
            },
        )
        output = "\n".join(
            [
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "toolUse",
                            "usage": {"input": 500, "output": 100},
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "error",
                            "errorMessage": "429: model_rate_limit",
                            "usage": {"input": 0, "output": 0},
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "error",
                            "errorMessage": "Provider finish_reason: error",
                            "usage": {"input": 0, "output": 0},
                        },
                    }
                ),
            ]
        )
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result(output)
        mock_env.capabilities.mounted = True

        with pytest.raises(TransientProviderError, match="transient failure"):
            await agent.run("Fix the bug", mock_env, AsyncMock())

        commands = [call.kwargs["command"] for call in mock_env.exec.call_args_list]
        assert "rm -f $HOME/.pi/agent/models.json" in commands[-1]

    @pytest.mark.asyncio
    async def test_api_key_forwarding_anthropic(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-5")
        mock_env = AsyncMock()
        mock_env.exec.return_value = _exec_result()
        env_vars = {
            "ANTHROPIC_API_KEY": "ak-123",
            "UNRELATED_KEY": "ignored",
        }
        with patch.dict(os.environ, env_vars, clear=False):
            await agent.run("Fix the bug", mock_env, AsyncMock())

        run_env = mock_env.exec.call_args_list[-1].kwargs["env"]
        assert run_env["ANTHROPIC_API_KEY"] == "ak-123"
        assert "UNRELATED_KEY" not in run_env

    @pytest.mark.asyncio
    async def test_api_key_forwarding_openai(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir, model_name="openai/gpt-4")
        mock_env = AsyncMock()
        mock_env.exec.side_effect = _exec_with_empty_sandbox_probe
        env_vars = {
            "OPENAI_API_KEY": "sk-456",
            "OPENAI_BASE_URL": "https://proxy.example/v1",
            "UNRELATED_KEY": "ignored",
        }
        with patch.dict(os.environ, env_vars, clear=False):
            await agent.run("Fix the bug", mock_env, AsyncMock())

        run_env = mock_env.exec.call_args_list[-1].kwargs["env"]
        assert run_env["OPENAI_API_KEY"] == "sk-456"
        assert run_env["OPENAI_BASE_URL"] == "https://proxy.example/v1"
        assert "UNRELATED_KEY" not in run_env

    @pytest.mark.asyncio
    async def test_custom_models_use_safe_template_and_runtime_materialization(
        self, temp_dir
    ):
        models_json = {
            "providers": {
                "openai": {
                    "baseUrl": "$OPENAI_BASE_URL",
                    "api": "openai-completions",
                    "apiKey": "$OPENAI_API_KEY",
                    "models": [{"id": "moonshotai/Kimi-K3:together"}],
                }
            }
        }
        agent = PiAgent(
            logs_dir=temp_dir,
            model_name="openai/moonshotai/Kimi-K3:together",
            models_json=models_json,
        )
        mock_env = AsyncMock()
        mock_env.exec.side_effect = _exec_with_empty_sandbox_probe
        mock_env.capabilities.mounted = False
        env_vars = {
            "OPENAI_API_KEY": "scoped-token",
            "OPENAI_BASE_URL": "https://proxy.example/scopes/private/v1",
        }

        with patch.dict(os.environ, env_vars, clear=False):
            await agent.run("Fix the bug", mock_env, AsyncMock())

        template = json.loads(
            (temp_dir / "pi.models.template.json").read_text(encoding="utf-8")
        )
        assert template == models_json
        assert "scoped-token" not in json.dumps(template)
        assert "/scopes/private/" not in json.dumps(template)
        commands = [call.kwargs["command"] for call in mock_env.exec.call_args_list]
        materialize = next(
            command for command in commands if "_materialize_pi_models_json" in command
        )
        assert "import os" in materialize
        mock_env.upload_file.assert_awaited_once_with(
            temp_dir / "pi.models.template.json",
            "/logs/agent/pi.models.template.json",
        )
        assert any("pi --print" in command for command in commands)
        assert "rm -f $HOME/.pi/agent/models.json" in commands[-1]

    @pytest.mark.parametrize(
        ("models_json", "message"),
        [
            ({}, "exactly one providers object"),
            (
                {"providers": {"openai": {"baseUrl": "https://x.test/?token=x"}}},
                "environment reference or a safe URL",
            ),
            (
                {
                    "providers": {
                        "openai": {
                            "baseUrl": "$OPENAI_BASE_URL",
                            "apiKey": "literal-secret",
                        }
                    }
                },
                "apiKey must be an environment reference",
            ),
            (
                {
                    "providers": {
                        "openai": {
                            "baseUrl": "$OPENAI_BASE_URL",
                            "apiKey": "!secret-command",
                        }
                    }
                },
                "apiKey must be an environment reference",
            ),
        ],
    )
    def test_custom_models_reject_unsafe_configuration(
        self, temp_dir, models_json, message
    ):
        with pytest.raises(ValueError, match=message):
            PiAgent(logs_dir=temp_dir, models_json=models_json)

    def test_thinking_cli_flag(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir, thinking="high")
        flags = agent.build_cli_flags()
        assert "--thinking high" in flags

    def test_thinking_invalid_value(self, temp_dir):
        with pytest.raises(ValueError, match="Valid values"):
            PiAgent(logs_dir=temp_dir, thinking="ultra")


class TestPiPopulateContext:
    def _write_jsonl(self, path, events):
        path.write_text("\n".join(json.dumps(e) for e in events) + "\n")

    def test_parses_token_usage(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        context = AgentContext()

        self._write_jsonl(
            temp_dir / "pi.txt",
            [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 100,
                            "output": 50,
                            "cacheRead": 20,
                            "cacheWrite": 10,
                            "cost": {"total": 0.005},
                        },
                    },
                },
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 200,
                            "output": 80,
                            "cacheRead": 30,
                            "cacheWrite": 5,
                            "cost": {"total": 0.008},
                        },
                    },
                },
            ],
        )

        agent.populate_context_post_run(context)

        assert context.n_input_tokens == 350  # input (100+200) + cacheRead (20+30)
        assert context.n_output_tokens == 130
        assert context.n_cache_tokens == 50  # cacheRead only (20 + 30)
        assert context.cost_usd == pytest.approx(0.013)

    def test_missing_output_file(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        context = AgentContext()
        agent.populate_context_post_run(context)
        # Should not raise, context stays at defaults (None)
        assert context.n_input_tokens is None
        assert context.n_output_tokens is None

    def test_ignores_non_assistant_messages(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        context = AgentContext()

        self._write_jsonl(
            temp_dir / "pi.txt",
            [
                {
                    "type": "message_end",
                    "message": {
                        "role": "user",
                        "usage": {"input": 999, "output": 999},
                    },
                },
                {"type": "tool_use", "name": "bash"},
            ],
        )

        agent.populate_context_post_run(context)
        assert context.n_input_tokens == 0
        assert context.n_output_tokens == 0

    def test_handles_malformed_jsonl(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        context = AgentContext()

        (temp_dir / "pi.txt").write_text(
            "not json\n"
            + json.dumps(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 10, "output": 5},
                    },
                }
            )
            + "\n"
        )

        agent.populate_context_post_run(context)
        assert context.n_input_tokens == 10
        assert context.n_output_tokens == 5

    def test_zero_cost_returns_none(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        context = AgentContext()

        self._write_jsonl(
            temp_dir / "pi.txt",
            [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 10, "output": 5},
                    },
                },
            ],
        )

        agent.populate_context_post_run(context)
        assert context.cost_usd is None

    def test_handles_null_nested_fields(self, temp_dir):
        agent = PiAgent(logs_dir=temp_dir)
        context = AgentContext()

        self._write_jsonl(
            temp_dir / "pi.txt",
            [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 10, "output": 5, "cost": None},
                    },
                },
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": None,
                    },
                },
                {
                    "type": "message_end",
                    "message": None,
                },
            ],
        )

        agent.populate_context_post_run(context)
        assert context.n_input_tokens == 10
        assert context.n_output_tokens == 5

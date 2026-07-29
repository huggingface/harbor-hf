"""Unit tests for Hermes agent CLI, trajectories, and context population."""

import json
from unittest.mock import AsyncMock

import pytest
import yaml
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.hermes.agent import HermesAgent, HermesRuntimeConfig


class TestHermesRunCommands:
    """Test run() and CLI flag construction."""

    @pytest.fixture(autouse=True)
    def _set_api_key(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        monkeypatch.delenv("ANTHROPIC_TOKEN", raising=False)

    def _get_run_call(self, exec_calls):
        """Find the exec call containing the main hermes run command."""
        for call in exec_calls:
            if "hermes --yolo chat" in call.kwargs["command"]:
                return call
        raise AssertionError("No hermes run command found in exec calls")

    @pytest.mark.asyncio
    async def test_anthropic_native_provider(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        run_call = self._get_run_call(mock_env.exec.call_args_list)
        assert "--provider anthropic" in run_call.kwargs["command"]
        assert "--model claude-sonnet-4-6" in run_call.kwargs["command"]
        assert run_call.kwargs["env"]["ANTHROPIC_API_KEY"] == "test-key"

    @pytest.mark.asyncio
    async def test_anthropic_token_fallback(self, temp_dir, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setenv("ANTHROPIC_TOKEN", "token-key")
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        run_call = self._get_run_call(mock_env.exec.call_args_list)
        assert run_call.kwargs["env"]["ANTHROPIC_TOKEN"] == "token-key"
        assert "--provider anthropic" in run_call.kwargs["command"]

    @pytest.mark.asyncio
    async def test_openai_native_provider(self, temp_dir, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
        agent = HermesAgent(logs_dir=temp_dir, model_name="openai/gpt-4o")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        run_call = self._get_run_call(mock_env.exec.call_args_list)
        assert "--model openai/gpt-4o" in run_call.kwargs["command"]
        assert "--provider" not in run_call.kwargs["command"]
        assert run_call.kwargs["env"]["OPENAI_API_KEY"] == "openai-key"

    @pytest.mark.asyncio
    async def test_openrouter_fallback(self, temp_dir, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
        agent = HermesAgent(logs_dir=temp_dir, model_name="meta/llama-3.1-70b")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        run_call = self._get_run_call(mock_env.exec.call_args_list)
        assert run_call.kwargs["env"]["OPENROUTER_API_KEY"] == "or-key"

    @pytest.mark.asyncio
    async def test_missing_model_slash_raises(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="no-slash")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        with pytest.raises(ValueError, match="provider/model_name"):
            await agent.run("do something", mock_env, AsyncMock())

    @pytest.mark.asyncio
    async def test_missing_api_key_raises(self, temp_dir, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_TOKEN", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
            await agent.run("do something", mock_env, AsyncMock())

    @pytest.mark.asyncio
    async def test_run_command_structure(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        run_call = self._get_run_call(mock_env.exec.call_args_list)
        run_cmd = run_call.kwargs["command"]
        assert "hermes --yolo chat" in run_cmd
        assert "-q" in run_cmd
        assert "-Q" in run_cmd
        assert "tee /logs/agent/hermes.txt" in run_cmd

    @pytest.mark.asyncio
    async def test_instruction_passed_via_env_var(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("solve the task", mock_env, AsyncMock())
        run_call = self._get_run_call(mock_env.exec.call_args_list)
        assert run_call.kwargs["env"]["HARBOR_INSTRUCTION"] == "solve the task"
        assert "$HARBOR_INSTRUCTION" in run_call.kwargs["command"]

    @pytest.mark.asyncio
    async def test_config_yaml_written(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        exec_calls = mock_env.exec.call_args_list
        assert "config.yaml" in exec_calls[0].kwargs["command"]

    def test_config_yaml_matches_shellbench_runtime_contract(self):
        config = yaml.safe_load(HermesAgent._build_config_yaml("test-model"))
        assert config == {
            "model": "test-model",
            "provider": "auto",
            "toolsets": ["hermes-cli"],
            "agent": {"max_turns": 90},
            "memory": {
                "memory_enabled": False,
                "user_profile_enabled": False,
            },
            "compression": {"enabled": True, "threshold": 0.85},
            "terminal": {"backend": "local", "timeout": 180},
            "delegation": {"max_iterations": 50},
            "checkpoints": {"enabled": False},
        }

    def test_runtime_config_rejects_unknown_fields(self):
        with pytest.raises(ValueError, match="Extra inputs are not permitted"):
            HermesRuntimeConfig.model_validate({"unknown": True})

    def test_provider_runtime_is_strict(self, temp_dir):
        agent = HermesAgent(
            logs_dir=temp_dir,
            model_name="openai/model",
            provider_runtime={
                "api": "chat-completions",
                "timeout_seconds": 17.5,
                "max_attempts": 3,
            },
        )
        assert agent._provider_runtime["timeout_seconds"] == 17.5
        with pytest.raises(ValueError, match="chat-completions API"):
            HermesAgent(
                logs_dir=temp_dir,
                model_name="openai/model",
                provider_runtime={
                    "api": "responses",
                    "timeout_seconds": 17.5,
                    "max_attempts": 3,
                },
            )

    @pytest.mark.asyncio
    async def test_cleanup_exports_redacted_selected_session(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
        await agent.run("do something", mock_env, AsyncMock())
        exec_calls = mock_env.exec.call_args_list
        cleanup_calls = [
            call
            for call in exec_calls
            if "hermes sessions export" in call.kwargs["command"]
        ]
        assert len(cleanup_calls) == 1
        cleanup = cleanup_calls[0].kwargs["command"]
        assert '--session-id "$session_id"' in cleanup
        assert "--yes --redact" in cleanup

    @pytest.mark.asyncio
    async def test_hf_jobs_ingress_is_hidden_from_hermes(self, temp_dir, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setenv("OPENAI_API_KEY", "scoped-route-capability")
        monkeypatch.setenv(
            "OPENAI_BASE_URL",
            "https://abc123--8000.hf.jobs/scopes/opaque/v1",
        )
        monkeypatch.setenv("HF_TOKEN", "private-hf-token")
        agent = HermesAgent(logs_dir=temp_dir, model_name="openai/routed-model")
        mock_env = AsyncMock()
        mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

        await agent.run("do something", mock_env, AsyncMock())

        run_call = self._get_run_call(mock_env.exec.call_args_list)
        assert run_call.kwargs["env"]["OPENAI_API_KEY"] == (
            "harbor-local-ingress-bridge"
        )
        assert run_call.kwargs["env"]["OPENAI_BASE_URL"] == (
            "http://127.0.0.1:18080/v1"
        )
        assert "HF_TOKEN" not in run_call.kwargs["env"]
        root_calls = [
            call
            for call in mock_env.exec.call_args_list
            if call.kwargs.get("user") == "root"
        ]
        assert len(root_calls) == 2
        assert root_calls[0].kwargs["env"]["HARBOR_HF_INGRESS_TOKEN"] == (
            "private-hf-token"
        )
        assert "private-hf-token" not in root_calls[0].kwargs["command"]
        assert "kill" in root_calls[1].kwargs["command"]


class TestHermesInstall:
    @pytest.mark.asyncio
    async def test_commit_revision_uses_commit_pinned_installer(self, temp_dir):
        revision = "cb06017b1d6e1b9ae0cb35f99a48ffa6bcbaa828"
        agent = HermesAgent(
            logs_dir=temp_dir, model_name="openai/model", version=revision
        )
        agent.exec_as_root = AsyncMock()
        agent.exec_as_agent = AsyncMock()

        await agent.install(AsyncMock())

        root_command = agent.exec_as_root.await_args.kwargs["command"]
        assert "curl git ripgrep xz-utils" in root_command
        command = agent.exec_as_agent.await_args.kwargs["command"]
        assert f"hermes-agent/{revision}/scripts/install.sh" in command
        assert f"--commit {revision}" in command
        assert "--branch" not in command

    @pytest.mark.asyncio
    async def test_named_revision_is_rejected(self, temp_dir):
        agent = HermesAgent(
            logs_dir=temp_dir, model_name="openai/model", version="main"
        )
        agent.exec_as_root = AsyncMock()
        agent.exec_as_agent = AsyncMock()

        with pytest.raises(ValueError, match="full Git commit"):
            await agent.install(AsyncMock())


class TestHermesAtifConversion:
    """Test ATIF trajectory conversion from hermes session data."""

    SAMPLE_SESSION = json.dumps(
        {
            "id": "session-1",
            "source": "cli",
            "messages": [
                {"role": "user", "content": "Complete the task."},
                {
                    "role": "assistant",
                    "content": "Let me check.",
                    "tool_calls": [
                        {
                            "id": "tc-1",
                            "function": {
                                "name": "terminal",
                                "arguments": json.dumps({"command": "ls"}),
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "tc-1",
                    "content": "file1.txt",
                },
                {
                    "role": "assistant",
                    "content": "Done.",
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                },
            ],
        }
    )

    def test_produces_valid_trajectory(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        trajectory = agent._convert_hermes_session_to_atif(
            self.SAMPLE_SESSION, "test-session"
        )
        assert trajectory is not None
        assert trajectory.schema_version == "ATIF-v1.7"
        assert trajectory.agent.name == "hermes"
        assert trajectory.steps[1].model_name == "anthropic/claude-sonnet-4-6"
        assert trajectory.steps[1].llm_call_count == 1

    def test_step_sources(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        trajectory = agent._convert_hermes_session_to_atif(
            self.SAMPLE_SESSION, "test-session"
        )
        sources = [s.source for s in trajectory.steps]
        assert sources == ["user", "agent", "agent"]

    def test_tool_call_and_observation(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        trajectory = agent._convert_hermes_session_to_atif(
            self.SAMPLE_SESSION, "test-session"
        )
        tool_step = [s for s in trajectory.steps if s.tool_calls][0]
        assert tool_step.tool_calls[0].function_name == "terminal"
        assert tool_step.observation is not None
        assert tool_step.observation.results[0].source_call_id == "tc-1"

    def test_token_counts(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        trajectory = agent._convert_hermes_session_to_atif(
            self.SAMPLE_SESSION, "test-session"
        )
        assert trajectory.final_metrics.total_prompt_tokens == 100
        assert trajectory.final_metrics.total_completion_tokens == 50

    def test_empty_input_returns_none(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        assert agent._convert_hermes_session_to_atif("", "s") is None

    def test_sequential_step_ids(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        trajectory = agent._convert_hermes_session_to_atif(
            self.SAMPLE_SESSION, "test-session"
        )
        for i, step in enumerate(trajectory.steps):
            assert step.step_id == i + 1

    def test_parallel_tools_and_unicode_separator_are_preserved(self, temp_dir):
        session = {
            "id": "session-parallel",
            "model": "routed-model",
            "input_tokens": 20,
            "output_tokens": 5,
            "cache_read_tokens": 8,
            "messages": [
                {"role": "user", "content": "work"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "one",
                            "function": {
                                "name": "read_file",
                                "arguments": '{"path":"/app/a"}',
                            },
                        },
                        {
                            "id": "two",
                            "function": {
                                "name": "read_file",
                                "arguments": '{"path":"/app/b"}',
                            },
                        },
                    ],
                },
                {"role": "tool", "tool_call_id": "one", "content": "a"},
                {"role": "tool", "tool_call_id": "two", "content": "b"},
                {"role": "assistant", "content": "line one\u2028line two"},
            ],
        }
        agent = HermesAgent(logs_dir=temp_dir, model_name="openai/routed-model")
        trajectory = agent._convert_hermes_session_to_atif(
            json.dumps(session, ensure_ascii=False) + "\n", "fallback"
        )

        assert trajectory is not None
        assert trajectory.session_id == "session-parallel"
        assert len(trajectory.steps[1].tool_calls) == 2
        assert len(trajectory.steps[1].observation.results) == 2
        assert trajectory.steps[-1].message == "line one\u2028line two"
        assert trajectory.final_metrics.total_prompt_tokens == 20
        assert trajectory.final_metrics.total_cached_tokens == 8
        assert trajectory.extra["canonical_model_identity"] is True


class TestHermesPopulateContext:
    """Test populate_context_post_run."""

    def test_writes_trajectory_and_sets_tokens(self, temp_dir):
        session = json.dumps(
            {
                "messages": [
                    {"role": "user", "content": "Hello"},
                    {
                        "role": "assistant",
                        "content": "Hi!",
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                    },
                ]
            }
        )
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        (temp_dir / "hermes-session.jsonl").write_text(session)

        context = AgentContext()
        agent.populate_context_post_run(context)

        assert (temp_dir / "trajectory.json").exists()
        data = json.loads((temp_dir / "trajectory.json").read_text())
        assert data["schema_version"] == "ATIF-v1.7"
        assert context.n_input_tokens == 10
        assert context.n_output_tokens == 5

    def test_no_session_file_no_trajectory(self, temp_dir):
        agent = HermesAgent(logs_dir=temp_dir, model_name="anthropic/claude-sonnet-4-6")
        context = AgentContext()
        agent.populate_context_post_run(context)
        assert not (temp_dir / "trajectory.json").exists()

"""Unit tests for OpenClawAgent installed agent ATIF mapping."""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from harbor.environments.capabilities import EnvironmentCapabilities
from harbor.models.agent.context import AgentContext
from harbor.models.agent.name import AgentName

from harbor_hf_agents.openclaw.agent import (
    OpenClawAgent,
    openclaw_session_jsonl_to_atif_steps,
)


@pytest.fixture
def agent(tmp_path: Path) -> OpenClawAgent:
    return OpenClawAgent(
        logs_dir=tmp_path,
        model_name="anthropic/claude-sonnet-4-20250514",
    )


def test_name(agent: OpenClawAgent) -> None:
    assert agent.name() == AgentName.OPENCLAW.value


def test_node_runtime_defaults_to_current_supported_major(tmp_path: Path) -> None:
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )

    assert "nvm use 24" in agent._node_command("openclaw --version")


def test_node_runtime_can_be_pinned_exactly(tmp_path: Path) -> None:
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        openclaw_node_version="24.15.0",
    )

    assert "nvm use 24.15.0" in agent._node_command("openclaw --version")


def test_load_json_object_trailing_noise(agent: OpenClawAgent) -> None:
    raw = 'prefix noise\n{"payloads": [], "meta": {}}\npost-run diagnostic\n'
    parsed = agent._load_json_object(raw)
    assert parsed == {"payloads": [], "meta": {}}


def test_load_json_object_stale_brace_before_envelope(agent: OpenClawAgent) -> None:
    """A ``{`` inside log lines must not hide the trailing CLI envelope."""
    raw = (
        '[tools] raw_params={"path": "/x"}\n'
        '{"payloads": [{"text": "ok"}], "meta": {"agentMeta": {"sessionId": "s"}}}\n'
    )
    parsed = agent._load_json_object(raw)
    assert parsed is not None
    assert parsed["meta"]["agentMeta"]["sessionId"] == "s"


def test_convert_envelope_basic(agent: OpenClawAgent) -> None:
    envelope = {
        "payloads": [
            {"text": "hello", "isReasoning": False},
            {"text": "think", "isReasoning": True},
        ],
        "meta": {
            "agentMeta": {
                "sessionId": "sess-abc",
                "usage": {"input": 10, "output": 5, "cacheRead": 2},
            },
        },
    }
    traj = agent._convert_envelope_to_trajectory(envelope, "do the thing")
    assert traj is not None
    assert traj.session_id == "sess-abc"
    assert len(traj.steps) == 2
    assert traj.steps[0].source == "user"
    assert traj.steps[0].message == "do the thing"
    assert traj.steps[1].source == "agent"
    assert traj.steps[1].message == "hello"
    assert traj.steps[1].reasoning_content == "think"
    assert traj.final_metrics is not None
    assert traj.final_metrics.total_prompt_tokens == 12
    assert traj.final_metrics.total_completion_tokens == 5
    assert traj.final_metrics.total_cached_tokens == 2


def test_populate_context_writes_trajectory(agent: OpenClawAgent) -> None:
    payload = {
        "payloads": [{"text": "ok"}],
        "meta": {"agentMeta": {"sessionId": "s1", "usage": {}}},
    }
    (agent.logs_dir / "openclaw.txt").write_text(json.dumps(payload, indent=2))
    (agent.logs_dir / "instruction.txt").write_text("task text")

    ctx = AgentContext()
    agent.populate_context_post_run(ctx)

    traj_path = agent.logs_dir / "trajectory.json"
    assert traj_path.is_file()
    out = json.loads(traj_path.read_text())
    assert out["session_id"] == "s1"
    assert len(out["steps"]) == 2
    assert out["steps"][0]["message"] == "task text"


def test_compose_config_patch_mcp(agent: OpenClawAgent, tmp_path: Path) -> None:
    from harbor.models.task.config import MCPServerConfig

    a = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        mcp_servers=[
            MCPServerConfig(
                name="demo",
                transport="stdio",
                command="mcp",
                args=["--stdio"],
            ),
        ],
        openclaw_config={"agents": {"defaults": {"verboseDefault": "off"}}},
    )
    cfg = a._build_full_openclaw_config()
    assert cfg["agents"]["defaults"]["verboseDefault"] == "off"
    assert cfg["mcp"]["servers"]["demo"]["command"] == "mcp"
    assert cfg["mcp"]["servers"]["demo"]["args"] == ["--stdio"]


def test_build_config_appends_unavailable_headless_tools(tmp_path: Path) -> None:
    a = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        openclaw_config={"tools": {"deny": ["web_search", "message"]}},
    )

    cfg = a._build_full_openclaw_config()

    assert cfg["tools"]["deny"] == [
        "web_search",
        "message",
        "cron",
    ]


def test_provider_base_url_from_env_in_uploaded_config(tmp_path: Path) -> None:
    """The provider base URL environment variable is merged into the catalog."""
    inference = "https://proxy.example.com/v1"
    a = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        extra_env={"OPENAI_BASE_URL": inference},
    )
    cfg = a._build_full_openclaw_config()
    assert cfg["models"]["providers"]["openai"]["baseUrl"] == "$OPENAI_BASE_URL"
    assert inference not in json.dumps(cfg)
    openai_models = cfg["models"]["providers"]["openai"]["models"]
    assert isinstance(openai_models, list)
    assert len(openai_models) == 1
    assert openai_models[0]["id"] == "gpt-4.1"


def test_provider_baseurl_only_gets_models_array(tmp_path: Path) -> None:
    """User YAML may set only ``baseUrl``; OpenClawAgent requires a ``models`` array."""
    custom = "https://example.com/v1"
    a = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        openclaw_config={
            "models": {"providers": {"openai": {"baseUrl": custom}}},
        },
    )
    cfg = a._build_full_openclaw_config()
    assert cfg["models"]["providers"]["openai"]["baseUrl"] == custom
    assert isinstance(cfg["models"]["providers"]["openai"]["models"], list)
    assert len(cfg["models"]["providers"]["openai"]["models"]) == 1
    assert cfg["models"]["providers"]["openai"]["models"][0]["id"] == "gpt-4.1"


@pytest.mark.asyncio
async def test_direct_settings_use_custom_provider_and_output_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = SimpleNamespace(
        capabilities=EnvironmentCapabilities(mounted=True),
        upload_file=AsyncMock(),
    )
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        provider_runtime={
            "api": "chat-completions",
            "timeout_seconds": 1800,
            "max_attempts": 1,
        },
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )
    exec_as_agent = AsyncMock()
    monkeypatch.setattr(agent, "exec_as_agent", exec_as_agent)
    monkeypatch.setattr(
        agent,
        "_copy_openclaw_session_file_to_agent_logs",
        AsyncMock(),
    )

    await agent.run("solve it", environment, AgentContext())

    config = json.loads((tmp_path / "openclaw.upload.json").read_text())
    provider = config["models"]["providers"]["harbor-hf-job"]
    assert provider["api"] == "openai-completions"
    assert provider["apiKey"] == "${OPENCLAW_HARBOR_API_KEY}"
    assert provider["baseUrl"] == "${OPENCLAW_HARBOR_BASE_URL}"
    assert provider["models"] == [
        {
            "id": "gpt-4.1",
            "name": "gpt-4.1",
            "maxTokens": 32768,
            "params": {"maxRetries": 0, "timeoutMs": 1_800_000},
        }
    ]
    run_call = next(
        call
        for call in exec_as_agent.await_args_list
        if "openclaw agent --local"
        in (call.kwargs["command"] if "command" in call.kwargs else call.args[1])
    )
    run_command = (
        run_call.kwargs["command"] if "command" in run_call.kwargs else run_call.args[1]
    )
    assert "--model harbor-hf-job/gpt-4.1" in run_command
    assert run_call.kwargs["env"]["OPENCLAW_HARBOR_API_KEY"] == "direct-token"
    assert (
        run_call.kwargs["env"]["OPENCLAW_HARBOR_BASE_URL"]
        == "https://router.huggingface.co/v1"
    )


@pytest.mark.asyncio
async def test_install_uses_the_prepared_environment_timeout(
    tmp_path: Path,
) -> None:
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
    )
    agent.exec_as_root = AsyncMock()
    agent.exec_as_agent = AsyncMock()

    await agent.install(AsyncMock())

    assert (
        "ca-certificates curl passwd python3 util-linux"
        in agent.exec_as_root.await_args.kwargs["command"]
    )
    assert "timeout_sec" not in agent.exec_as_root.await_args.kwargs
    assert all(
        "timeout_sec" not in call.kwargs for call in agent.exec_as_agent.await_args_list
    )


def test_supported_providers(tmp_path: Path) -> None:
    """Out-of-the-box support is intentionally limited to anthropic, nvidia, openai."""
    a = OpenClawAgent(logs_dir=tmp_path, model_name="openai/gpt-4.1")
    assert frozenset({"anthropic", "nvidia", "openai"}) == a._SUPPORTED_PROVIDERS


def test_openclaw_session_commands_are_self_contained(tmp_path: Path) -> None:
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        openclaw_agent_id="custom agent",
    )

    copy_command = agent._shell_copy_openclaw_session_to_logs()
    persist_command = agent._shell_persist_openclaw_sessions()

    assert "python3 -c" in copy_command
    assert "_openclaw_container_copy_session_transcript" in copy_command
    assert "agent_id=custom-agent" in persist_command
    assert "/logs/agent/openclaw-sessions" in persist_command
    assert 'ln -s "$logs_dir" "$state_dir"' in persist_command


@pytest.mark.parametrize(
    ("raw_agent_id", "normalized_agent_id"),
    [
        ("Worker", "worker"),
        (" custom agent ", "custom-agent"),
        ("---", "main"),
        ("a" * 65, "a" * 64),
        (None, "main"),
    ],
)
def test_openclaw_session_path_uses_normalized_agent_id(
    tmp_path: Path,
    raw_agent_id: str | None,
    normalized_agent_id: str,
) -> None:
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        openclaw_agent_id=raw_agent_id,
    )

    command = agent._shell_persist_openclaw_sessions()

    assert f"agent_id={normalized_agent_id}" in command


@pytest.mark.asyncio
async def test_run_redirects_sessions_before_agent_execution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = SimpleNamespace(
        capabilities=EnvironmentCapabilities(mounted=True),
        upload_file=AsyncMock(),
    )
    commands: list[str] = []

    async def execute(*_args, **kwargs) -> None:
        command = kwargs.get("command") or _args[1]
        commands.append(command)
        if "openclaw agent --local" in command:
            raise RuntimeError("agent timed out")

    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )
    monkeypatch.setattr(agent, "exec_as_agent", AsyncMock(side_effect=execute))
    copy_session = AsyncMock()
    monkeypatch.setattr(
        agent,
        "_copy_openclaw_session_file_to_agent_logs",
        copy_session,
    )

    with pytest.raises(RuntimeError, match="agent timed out"):
        await agent.run("solve it", environment, AgentContext())

    persist_index = next(
        i for i, command in enumerate(commands) if "openclaw-sessions" in command
    )
    config_index = next(
        i for i, command in enumerate(commands) if "openclaw.upload.json" in command
    )
    agent_index = next(
        i for i, command in enumerate(commands) if "openclaw agent --local" in command
    )
    assert not any("openclaw setup" in command for command in commands)
    assert config_index < persist_index < agent_index
    copy_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_continues_when_session_redirect_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = SimpleNamespace(
        capabilities=EnvironmentCapabilities(mounted=True),
        upload_file=AsyncMock(),
    )
    commands: list[str] = []

    async def execute(*_args, **kwargs) -> None:
        command = kwargs.get("command") or _args[1]
        commands.append(command)
        if "openclaw-sessions" in command:
            raise RuntimeError("session redirect failed")

    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )
    monkeypatch.setattr(agent, "exec_as_agent", AsyncMock(side_effect=execute))
    monkeypatch.setattr(
        agent,
        "_copy_openclaw_session_file_to_agent_logs",
        AsyncMock(),
    )

    await agent.run("solve it", environment, AgentContext())

    assert any("openclaw agent --local" in command for command in commands)


@pytest.mark.asyncio
@pytest.mark.parametrize("mounted", [False, True])
async def test_run_uploads_config_to_non_mounted_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mounted: bool,
) -> None:
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )
    upload_file = AsyncMock()
    environment = SimpleNamespace(
        capabilities=EnvironmentCapabilities(mounted=mounted),
        upload_file=upload_file,
    )
    exec_as_agent = AsyncMock()
    copy_session = AsyncMock()
    monkeypatch.setattr(agent, "exec_as_agent", exec_as_agent)
    monkeypatch.setattr(
        agent,
        "_copy_openclaw_session_file_to_agent_logs",
        copy_session,
    )

    await agent.run("solve it", environment, AgentContext())

    upload_path = tmp_path / "openclaw.upload.json"
    assert upload_path.is_file()
    if mounted:
        upload_file.assert_not_awaited()
    else:
        upload_file.assert_awaited_once_with(
            upload_path,
            "/logs/agent/openclaw.upload.json",
        )


@pytest.mark.asyncio
async def test_run_creates_missing_logs_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs_dir = tmp_path / "trial" / "agent"
    agent = OpenClawAgent(
        logs_dir=logs_dir,
        model_name="openai/gpt-4.1",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
            "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
        },
    )
    environment = SimpleNamespace(
        capabilities=EnvironmentCapabilities(mounted=True),
        upload_file=AsyncMock(),
    )
    monkeypatch.setattr(agent, "exec_as_agent", AsyncMock())
    monkeypatch.setattr(
        agent,
        "_copy_openclaw_session_file_to_agent_logs",
        AsyncMock(),
    )

    await agent.run("solve it", environment, AgentContext())

    assert (logs_dir / "openclaw.upload.json").is_file()


def test_provider_env_keys_convention(tmp_path: Path) -> None:
    """Supported providers derive env vars from the ``<PROVIDER>_*`` convention."""
    a = OpenClawAgent(logs_dir=tmp_path, model_name="openai/gpt-4.1")
    assert a._provider_env_keys("openai") == ("OPENAI_API_KEY", "OPENAI_BASE_URL")
    assert a._provider_env_keys("anthropic") == (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
    )
    assert a._provider_env_keys("nvidia") == ("NVIDIA_API_KEY", "NVIDIA_BASE_URL")


def test_validate_provider_accepts_supported(tmp_path: Path) -> None:
    a = OpenClawAgent(logs_dir=tmp_path, model_name="openai/gpt-4.1")
    for provider in ("anthropic", "nvidia", "openai"):
        a._validate_provider(provider)


def test_validate_provider_rejects_unsupported(tmp_path: Path) -> None:
    a = OpenClawAgent(logs_dir=tmp_path, model_name="openai/gpt-4.1")
    with pytest.raises(ValueError, match="Unsupported provider 'google'"):
        a._validate_provider("google")
    with pytest.raises(ValueError, match="Unsupported provider 'openai-typo'"):
        a._validate_provider("openai-typo")


def test_subclass_can_add_supported_provider(tmp_path: Path) -> None:
    """Adding a new provider is a one-line subclass override."""

    class CustomOpenClawAgent(OpenClawAgent):
        _SUPPORTED_PROVIDERS = OpenClawAgent._SUPPORTED_PROVIDERS | {"deepseek"}

    a = CustomOpenClawAgent(logs_dir=tmp_path, model_name="deepseek/deepseek-chat")
    a._validate_provider("deepseek")
    assert a._provider_env_keys("deepseek") == (
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_BASE_URL",
    )


def test_provider_base_url_openclaw_config_wins(tmp_path: Path) -> None:
    """User-provided ``baseUrl`` in openclaw_config wins over env var."""
    custom = "https://example.com/v1"
    a = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        extra_env={"OPENAI_BASE_URL": "https://proxy.example.com/v1"},
        openclaw_config={
            "models": {"providers": {"openai": {"baseUrl": custom}}},
        },
    )
    cfg = a._build_full_openclaw_config()
    assert cfg["models"]["providers"]["openai"]["baseUrl"] == custom
    openai_models = cfg["models"]["providers"]["openai"]["models"]
    assert isinstance(openai_models, list)
    assert len(openai_models) == 1
    assert openai_models[0]["id"] == "gpt-4.1"


def test_openclaw_session_jsonl_to_atif_steps_minimal(tmp_path: Path) -> None:
    session = tmp_path / "openclaw.session.jsonl"
    session.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "message",
                        "timestamp": "2026-01-01T00:00:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "hi"}],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "timestamp": "2026-01-01T00:00:01Z",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "hello "},
                                {
                                    "type": "toolCall",
                                    "id": "c1",
                                    "name": "exec",
                                    "arguments": {"command": "x"},
                                },
                            ],
                            "usage": {"input": 1, "output": 2, "cacheRead": 0},
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "timestamp": "2026-01-01T00:00:02Z",
                        "message": {
                            "role": "toolResult",
                            "toolCallId": "c1",
                            "toolName": "exec",
                            "content": [{"type": "text", "text": "out"}],
                            "details": {"aggregated": "out"},
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "timestamp": "2026-01-01T00:00:03Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "done"}],
                            "usage": {"input": 3, "output": 4, "cacheRead": 0},
                        },
                    }
                ),
            ]
        )
        + "\n"
    )
    steps = openclaw_session_jsonl_to_atif_steps(
        session,
        instruction="task from instruction",
        model_name="anthropic/claude-sonnet-4-20250514",
    )
    assert steps is not None
    assert len(steps) == 3
    assert steps[0].message == "task from instruction"
    assert steps[1].tool_calls is not None
    assert steps[1].observation is not None


def test_populate_context_optional_session_jsonl(tmp_path: Path) -> None:
    session = tmp_path / "openclaw.session.jsonl"
    session.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "u"}],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "a"}],
                            "usage": {"input": 1, "output": 1, "cacheRead": 0},
                        },
                    }
                ),
            ]
        )
        + "\n"
    )
    payload = {
        "payloads": [{"text": "summary"}],
        "meta": {"agentMeta": {"sessionId": "s1", "usage": {"input": 9, "output": 9}}},
    }
    agent = OpenClawAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-4.1",
        session_to_trajectory=True,
    )
    (tmp_path / "openclaw.txt").write_text(json.dumps(payload))
    (tmp_path / "instruction.txt").write_text("instr")
    ctx = AgentContext()
    agent.populate_context_post_run(ctx)
    out = json.loads((tmp_path / "trajectory.json").read_text())
    assert len(out["steps"]) == 2
    assert out["steps"][1]["message"] == "a"

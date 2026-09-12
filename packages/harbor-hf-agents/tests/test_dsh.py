"""Offline adapter contracts: native trajectory models and sandbox boundaries."""

import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import yaml
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.dsh.agent import DshAgent


@pytest.fixture
def agent(tmp_path):
    return DshAgent(logs_dir=tmp_path, model_name="provider/model", version="1.2.3")


def session(agent, events):
    path = agent.logs_dir / "dsh-sessions" / "session" / "session.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(event) for event in events))
    return path


def test_settings_and_patch_are_secret_free(agent):
    patch = yaml.safe_load(agent._eval_patch())
    assert patch[0]["config"] == {"provider": "harbor", "model": "model"}
    assert patch[1]["config"] == {
        "root": str(agent.logs_dir / "dsh-sessions"),
        "compression": "none",
        "packChunks": False,
    }
    assert patch[2] == {"id": "session-title-llm", "disabled": True}
    route = yaml.safe_load(agent._settings("https://inference.example/v1"))
    assert route["llm-pi-ai"]["providers"]["harbor"] == {
        "apiKeyEnv": "DSH_API_KEY",
        "api": "openai-completions",
        "baseURL": "https://inference.example/v1",
        "models": [{"id": "model"}],
    }
    agent._thinking_format = "synthetic-format"
    route = yaml.safe_load(agent._settings("https://inference.example/v1"))
    assert route["llm-pi-ai"]["providers"]["harbor"]["compat"] == {
        "thinkingFormat": "synthetic-format"
    }
    assert agent.name() == "dsh"
    assert agent.get_version_command().endswith("dsh --version")


@pytest.mark.parametrize("model", [None, "unqualified"])
def test_model_requires_provider(agent, model):
    agent.model_name = model
    with pytest.raises(ValueError, match="provider/model_name"):
        agent._eval_patch()


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [False, True])
async def test_route_environment_aliases_only_when_needed(agent, monkeypatch, native):
    values = {
        "OPENAI_API_KEY": "synthetic-key",
        "OPENAI_BASE_URL": "https://inference.example/v1",
    }
    if native:
        values.update(
            DSH_API_KEY="synthetic-native-key", DSH_BASE_URL="https://native.example/v1"
        )
    monkeypatch.setattr(agent, "_get_env", values.get)
    env = await agent._prepare_inference_env(SimpleNamespace())
    assert env["DSH_API_KEY"] == values.get("DSH_API_KEY", values["OPENAI_API_KEY"])
    assert env["DSH_BASE_URL"] == values.get("DSH_BASE_URL", values["OPENAI_BASE_URL"])
    assert env["DSH_TELEMETRY_DISABLED"] == "1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values",
    [
        {},
        {"OPENAI_API_KEY": "synthetic-key"},
        {"OPENAI_BASE_URL": "https://inference.example/v1"},
    ],
)
async def test_missing_route_fails_before_execution(agent, monkeypatch, values):
    monkeypatch.setattr(agent, "_get_env", values.get)
    with pytest.raises(RuntimeError, match="requires the OpenAI route"):
        await agent._prepare_inference_env(SimpleNamespace())


@pytest.mark.asyncio
@pytest.mark.parametrize("mounted", [True, False])
async def test_upload_uses_correct_environment_boundary(agent, monkeypatch, mounted):
    environment = SimpleNamespace(
        capabilities=SimpleNamespace(mounted=mounted), upload_file=AsyncMock()
    )
    execute = AsyncMock()
    monkeypatch.setattr(agent, "exec_as_root", execute)
    await agent._upload_text(
        environment,
        content="settings",
        remote_path="/installed-agent/settings.yaml",
        filename="settings.yaml",
    )
    assert (agent.logs_dir / "settings.yaml").read_text() == "settings"
    if mounted:
        environment.upload_file.assert_not_awaited()
        assert "install -D -m 0644" in execute.call_args.kwargs["command"]
        assert execute.call_args.kwargs["command"].endswith(
            "/installed-agent/settings.yaml"
        )
    else:
        execute.assert_not_awaited()
        environment.upload_file.assert_awaited_once_with(
            agent.logs_dir / "settings.yaml", "/installed-agent/settings.yaml"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("version,expected", [("1.2.3", "@1.2.3"), (None, "@latest")])
async def test_install_requests_pinned_package_without_executing(
    agent, monkeypatch, version, expected
):
    agent._version = version
    root, execute = AsyncMock(), AsyncMock()
    monkeypatch.setattr(agent, "exec_as_root", root)
    monkeypatch.setattr(agent, "exec_as_agent", execute)
    await agent.install(SimpleNamespace())
    assert root.await_count == 2
    assert root.call_args_list[0].kwargs["env"] == {"DEBIAN_FRONTEND": "noninteractive"}
    assert "@deepseek-ai/dsh" + expected in execute.call_args.kwargs["command"]
    assert "chown -R harbor-agent:harbor-agent" in root.call_args.kwargs["command"]


@pytest.mark.parametrize(
    "value,expected",
    [({}, None), ({"time": "bad"}, None), ({"time": 0}, "1970-01-01T00:00:00Z")],
)
def test_timestamps(agent, value, expected):
    assert agent._timestamp(value) == expected


@pytest.mark.parametrize("value", [None, [], True, -1, 1.5, "4"])
def test_invalid_usage_does_not_invent_tokens(agent, value):
    assert agent._token_count({"inputTokens": value}, "inputTokens") == 0
    assert agent._token_count(value, "inputTokens") == 0


@pytest.mark.parametrize(
    "arguments,expected",
    [
        (' {"x":1}', {"x": 1}),
        ("[1]", {"_raw": "[1]"}),
        ("broken", {"_raw": "broken"}),
        ("", {}),
        (None, {}),
    ],
)
def test_tool_arguments_preserve_unparseable_evidence(agent, arguments, expected):
    calls = agent._tool_calls(
        [
            None,
            {"type": "text"},
            {
                "type": "tool-call",
                "id": "call-1",
                "name": "inspect",
                "arguments": arguments,
            },
        ]
    )
    assert len(calls) == 1
    assert calls[0].arguments == expected
    assert calls[0].tool_call_id == "call-1"
    assert calls[0].function_name == "inspect"
    assert agent._tool_calls(None) == []


def test_session_conversion_links_observation_and_native_metrics(agent):
    path = session(
        agent,
        [
            [],
            {"type": "user"},
            {"type": "assistant", "data": None},
            {"type": "tool/result", "data": {"id": "unmatched"}},
            {
                "type": "assistant",
                "time": 0,
                "data": {
                    "content": [
                        None,
                        {"type": "text", "text": "hello"},
                        {"type": "text", "text": "world"},
                        {"type": "text", "text": 4},
                        {
                            "type": "tool-call",
                            "id": "call-1",
                            "name": "inspect",
                            "arguments": "{}",
                        },
                    ],
                    "usage": {
                        "inputTokens": 10,
                        "cacheReadTokens": 2,
                        "cacheWriteTokens": 3,
                        "outputTokens": 4,
                    },
                },
            },
            {
                "type": "tool/result",
                "data": {
                    "id": "call-1",
                    "content": [{"type": "text", "text": "observed"}],
                },
            },
            {"type": "assistant", "data": {"content": None}},
        ],
    )
    with path.open("a") as handle:
        handle.write("\n\nbroken json\n")
    context = AgentContext()
    agent._write_trajectory(context)
    trajectory = json.loads((agent.logs_dir / "trajectory.json").read_text())
    assert trajectory["session_id"] == "session"
    assert len(trajectory["steps"]) == 2
    step = trajectory["steps"][0]
    assert step["message"] == "hello\nworld"
    assert step["observation"]["results"][0]["content"] == "observed"
    assert step["metrics"]["prompt_tokens"] == 15
    assert step["metrics"]["cached_tokens"] == 2
    assert context.n_input_tokens == 15
    assert context.n_output_tokens == 4
    assert context.cost_usd is None


def test_empty_and_unreadable_sessions_do_not_write_trajectory(agent, monkeypatch):
    context = AgentContext()
    agent._write_trajectory(context)
    root = agent.logs_dir / "dsh-sessions"
    root.mkdir()
    assert agent._find_session_log() is None
    path = session(agent, [{"type": "user"}])
    agent._write_trajectory(context)
    assert not (agent.logs_dir / "trajectory.json").exists()

    def unreadable(self, **kwargs):
        raise OSError("unreadable")

    monkeypatch.setattr(type(path), "read_text", unreadable)
    assert agent._convert_session() is None


def test_latest_session_selected(agent):
    older = session(agent, [])
    newer = older.parent.parent / "newer" / "session.jsonl"
    newer.parent.mkdir()
    newer.write_text("")
    os.utime(older, (1, 1))
    os.utime(newer, (2, 2))
    assert agent._find_session_log() == newer

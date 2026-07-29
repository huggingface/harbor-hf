"""Tests for the OpenClaw Codex-runtime adapter."""

import json
from pathlib import Path
from typing import Any

import pytest
from harbor.agents.factory import AgentFactory
from harbor.models.trial.config import AgentConfig

from harbor_hf_agents.openclaw_codex.agent import (
    OpenClawCodexAgent,
    _collect_openclaw_codex_evidence,
    _materialize_openclaw_codex_config,
)


def test_factory_creates_registered_openclaw_codex_agent(tmp_path: Path) -> None:
    config = AgentConfig(
        import_path=("harbor_hf_agents.openclaw_codex.agent:OpenClawCodexAgent"),
        model_name="openai/zai-org/GLM-5.2:together",
    )

    agent = AgentFactory.create_agent_from_config(config, logs_dir=tmp_path)

    assert isinstance(agent, OpenClawCodexAgent)
    assert agent.name() == "openclaw-codex"


def test_codex_trajectory_uses_subclass_identity(tmp_path: Path) -> None:
    agent = OpenClawCodexAgent(
        logs_dir=tmp_path,
        model_name="openai/moonshotai/Kimi-K3:together",
        version="2026.7.1-2",
    )

    fallback = agent._convert_envelope_to_trajectory(
        {"payloads": [{"text": "done"}], "meta": {}}, "task"
    )

    assert fallback is not None
    session = agent._trajectory_from_envelope_with_steps({}, fallback.steps)
    assert fallback.agent.name == "openclaw-codex"
    assert session is not None
    assert session.agent.name == "openclaw-codex"


def test_codex_config_uses_selected_openclaw_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:18080/v1")
    monkeypatch.setenv("OPENCLAW_AGENT_ID", "custom-agent")

    _materialize_openclaw_codex_config()

    config = (
        tmp_path
        / ".openclaw"
        / "agents"
        / "custom-agent"
        / "agent"
        / "codex-home"
        / "config.toml"
    )
    assert config.read_text() == 'openai_base_url = "http://127.0.0.1:18080/v1"\n'


def test_codex_runtime_config_is_forced_for_selected_model(tmp_path: Path) -> None:
    agent = OpenClawCodexAgent(
        logs_dir=tmp_path,
        model_name="openai/moonshotai/Kimi-K3:together",
        openclaw_config={
            "plugins": {"allow": ["example"]},
            "agents": {"defaults": {"models": {}}},
        },
        codex_plugin_version="2026.7.1-1",
        codex_request_timeout_ms=123_000,
        model_context_window=131_072,
        model_max_tokens=16_384,
        extra_env={"OPENAI_BASE_URL": "https://proxy.example/scopes/secret-route/v1"},
    )

    config = agent._build_full_openclaw_config()

    assert config["plugins"]["allow"] == ["example", "codex"]
    codex = config["plugins"]["entries"]["codex"]
    assert codex == {
        "enabled": True,
        "config": {
            "discovery": {"enabled": False},
            "appServer": {
                "mode": "yolo",
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "requestTimeoutMs": 123_000,
            },
        },
    }
    model = "openai/moonshotai/Kimi-K3:together"
    assert config["agents"]["defaults"]["models"][model] == {
        "agentRuntime": {"id": "codex"}
    }
    provider = config["models"]["providers"]["openai"]
    assert provider["api"] == "openai-responses"
    assert provider["baseUrl"] == "https://router.huggingface.co/v1"
    assert provider["apiKey"] == "harbor-hf-scoped-provider-proxy"
    assert provider["models"] == [
        {
            "id": "moonshotai/Kimi-K3:together",
            "name": "moonshotai/Kimi-K3:together",
            "reasoning": True,
            "input": ["text"],
            "contextWindow": 131_072,
            "maxTokens": 16_384,
        }
    ]
    assert "secret-route" not in json.dumps(config)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"codex_plugin_version": ""}, "exact npm version"),
        ({"codex_plugin_version": "bad version"}, "exact npm version"),
        ({"codex_request_timeout_ms": 0}, "must be positive"),
        ({"model_context_window": 0}, "token limits must be positive"),
        (
            {"model_context_window": 10, "model_max_tokens": 11},
            "output limit exceeds",
        ),
    ],
)
def test_codex_runtime_configuration_rejects_invalid_values(
    tmp_path: Path, kwargs: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        OpenClawCodexAgent(
            logs_dir=tmp_path,
            model_name="openai/org/model",
            **kwargs,
        )


def test_collect_runtime_evidence_validates_harness_and_retains_transcripts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    logs = tmp_path / "logs"
    home = tmp_path / "home"
    sessions = home / ".openclaw" / "agents" / "main" / "sessions"
    codex_home = sessions.parent / "codex-home"
    native = codex_home / "sessions" / "2026" / "07"
    logs.mkdir()
    sessions.mkdir(parents=True)
    native.mkdir(parents=True)

    session_file = sessions / "session-one.jsonl"
    session_file.write_text('{"type":"message"}\n')
    (sessions / "sessions.json").write_text(
        json.dumps(
            {
                "agent:main:main": {
                    "sessionId": "session-one",
                    "agentHarnessId": "codex",
                    "sessionFile": str(session_file),
                }
            }
        )
    )
    Path(f"{session_file}.codex-app-server.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "threadId": "thread-one",
                "model": "moonshotai/Kimi-K3:together",
                "modelProvider": "openai",
            }
        )
    )
    capability = "private-capability-value"
    scoped_url = f"https://proxy.example/scopes/{capability}/v1"
    monkeypatch.setenv("OPENAI_API_KEY", "runtime-only-key")
    monkeypatch.setenv("OPENAI_BASE_URL", scoped_url)
    (native / "rollout-one.jsonl").write_text(
        json.dumps(
            {
                "type": "session_meta",
                "threadId": "thread-one",
                "baseUrl": scoped_url,
                "apiKey": "runtime-only-key",
            }
        )
        + "\n"
    )
    (codex_home / "auth.json").write_text("must-not-be-copied")
    envelope = {
        "payloads": [{"text": "done"}],
        "meta": {
            "agentMeta": {
                "sessionId": "session-one",
                "sessionFile": str(session_file),
            },
            "executionTrace": {
                "runner": "embedded",
                "winnerProvider": "openai",
            },
        },
    }
    (logs / "openclaw.txt").write_text(
        "log prefix\n" + json.dumps(envelope) + "\npost-run diagnostic\n"
    )

    _collect_openclaw_codex_evidence(str(logs), str(home))

    retained = logs / "codex-runtime"
    evidence = json.loads((retained / "runtime-evidence.json").read_text())
    assert evidence["agentHarnessId"] == "codex"
    assert evidence["threadId"] == "thread-one"
    assert evidence["nativeTranscriptFiles"] == 1
    assert evidence["matchingNativeTranscriptFiles"] == 1
    assert evidence["executionTrace"]["runner"] == "embedded"
    assert evidence["redactionCount"] >= 1
    retained_text = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in retained.rglob("*")
        if path.is_file()
    )
    assert capability not in retained_text
    assert scoped_url not in retained_text
    assert "runtime-only-key" not in retained_text
    assert "[REDACTED]" in retained_text
    assert (retained / "openclaw.session.jsonl").is_file()
    assert (retained / "codex-app-server-binding.json").is_file()
    assert list((retained / "native-sessions").rglob("rollout-one.jsonl"))
    assert not list(retained.rglob("auth.json"))


def test_collect_runtime_evidence_fails_closed_without_codex_harness(
    tmp_path: Path,
) -> None:
    logs = tmp_path / "logs"
    sessions = tmp_path / "home" / ".openclaw" / "agents" / "main" / "sessions"
    logs.mkdir()
    sessions.mkdir(parents=True)
    session_file = sessions / "session-one.jsonl"
    session_file.write_text("\n")
    (sessions / "sessions.json").write_text(
        json.dumps(
            {
                "agent:main:main": {
                    "sessionId": "session-one",
                    "agentHarnessId": "openclaw",
                }
            }
        )
    )
    (logs / "openclaw.txt").write_text(
        json.dumps(
            {
                "payloads": [],
                "meta": {
                    "agentMeta": {
                        "sessionId": "session-one",
                        "sessionFile": str(session_file),
                    }
                },
            }
        )
    )

    with pytest.raises(RuntimeError, match="did not use the Codex harness"):
        _collect_openclaw_codex_evidence(str(logs), str(tmp_path / "home"))

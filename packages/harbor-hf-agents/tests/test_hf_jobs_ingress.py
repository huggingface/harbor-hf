from __future__ import annotations

from types import SimpleNamespace

import pytest

from harbor_hf_agents.support.hf_jobs_ingress import (
    is_hf_jobs_ingress_url,
    prepare_hf_jobs_ingress_bridge,
)


class RecordingAgent:
    def __init__(self) -> None:
        self.calls: list[tuple[object, str, dict[str, str]]] = []
        self.agent_calls: list[tuple[object, str]] = []

    async def exec_as_root(
        self,
        environment: object,
        *,
        command: str,
        env: dict[str, str] | None = None,
    ) -> None:
        self.calls.append((environment, command, env or {}))

    async def exec_as_agent(self, environment: object, *, command: str) -> None:
        self.agent_calls.append((environment, command))


class FailingIsolationAgent(RecordingAgent):
    async def exec_as_agent(self, environment: object, *, command: str) -> None:
        await super().exec_as_agent(environment, command=command)
        raise RuntimeError("isolation failed")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://abc123--8000.hf.jobs/scopes/opaque/v1", True),
        ("https://abc123--8000.hf.jobs/scopes/opaque/v1?token=secret", False),
        ("https://user:secret@abc123--8000.hf.jobs/scopes/opaque/v1", False),
        ("https://router.huggingface.co/v1", False),
        ("http://abc123--8000.hf.jobs/v1", False),
        ("http://127.0.0.1:8000/v1", False),
    ],
)
def test_hf_jobs_ingress_url_validation(value: str, expected: bool) -> None:
    assert is_hf_jobs_ingress_url(value) is expected


@pytest.mark.asyncio
async def test_bridge_isolates_ingress_token_from_agent_environment(
    monkeypatch,
) -> None:
    monkeypatch.setenv("HF_TOKEN", "private-hf-token")
    agent = RecordingAgent()
    environment = SimpleNamespace()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://abc123--8000.hf.jobs/scopes/opaque/v1",
    }

    await prepare_hf_jobs_ingress_bridge(
        agent,  # type: ignore[arg-type]
        environment,  # type: ignore[arg-type]
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        ingress_token="private-hf-token",
        api="chat-completions",
    )

    assert env == {
        "OPENAI_API_KEY": "harbor-local-ingress-bridge",
        "OPENAI_BASE_URL": "http://127.0.0.1:18080/v1",
    }
    assert len(agent.calls) == 1
    called_environment, command, root_env = agent.calls[0]
    assert called_environment is environment
    assert "private-hf-token" not in command
    assert root_env == {
        "HARBOR_HF_INGRESS_UPSTREAM": ("https://abc123--8000.hf.jobs/scopes/opaque"),
        "HARBOR_HF_INGRESS_TOKEN": "private-hf-token",
        "HARBOR_HF_INGRESS_LOCAL_PORT": "18080",
        "HARBOR_HF_INGRESS_ALLOWED_PATH": "/v1/chat/completions",
    }
    assert len(agent.agent_calls) == 1
    assert "bridge_environment_readable" in agent.agent_calls[0][1]


@pytest.mark.asyncio
async def test_responses_bridge_allows_only_the_responses_route(monkeypatch) -> None:
    monkeypatch.setenv("HF_TOKEN", "private-hf-token")
    agent = RecordingAgent()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://abc123--8000.hf.jobs/scopes/opaque/v1",
    }

    await prepare_hf_jobs_ingress_bridge(
        agent,  # type: ignore[arg-type]
        SimpleNamespace(),  # type: ignore[arg-type]
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        ingress_token="private-hf-token",
        api="responses",
    )

    assert agent.calls[0][2]["HARBOR_HF_INGRESS_ALLOWED_PATH"] == "/v1/responses"


@pytest.mark.asyncio
async def test_bridge_is_stopped_when_isolation_check_fails() -> None:
    agent = FailingIsolationAgent()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://abc123--8000.hf.jobs/scopes/opaque/v1",
    }

    with pytest.raises(RuntimeError, match="isolation failed"):
        await prepare_hf_jobs_ingress_bridge(
            agent,  # type: ignore[arg-type]
            SimpleNamespace(),  # type: ignore[arg-type]
            env,
            base_url_key="OPENAI_BASE_URL",
            api_key_key="OPENAI_API_KEY",
            ingress_token="private-hf-token",
            api="chat-completions",
        )

    assert len(agent.calls) == 2
    assert "kill" in agent.calls[1][1]


@pytest.mark.asyncio
async def test_bridge_leaves_non_ingress_provider_unchanged(monkeypatch) -> None:
    monkeypatch.delenv("HF_TOKEN", raising=False)
    agent = RecordingAgent()
    env = {
        "OPENAI_API_KEY": "provider-key",
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
    }

    await prepare_hf_jobs_ingress_bridge(
        agent,  # type: ignore[arg-type]
        SimpleNamespace(),  # type: ignore[arg-type]
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        ingress_token=None,
        api="chat-completions",
    )

    assert agent.calls == []
    assert env["OPENAI_API_KEY"] == "provider-key"

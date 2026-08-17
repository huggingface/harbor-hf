from __future__ import annotations

from types import SimpleNamespace

import pytest

from harbor_hf_agents.support.hf_inference_bridge import (
    is_hf_inference_url,
    prepare_hf_inference_bridge,
)

_LIMITS = {
    "max_requests": "256",
    "max_concurrency": "4",
    "timeout_seconds": "1800",
    "max_output_tokens": "32768",
}


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
        ("https://router.huggingface.co/v1", True),
        ("https://route.us-east-1.aws.endpoints.huggingface.cloud/v1", True),
        ("https://abc123--8000.hf.jobs/scopes/opaque/v1?token=secret", False),
        ("https://user:secret@abc123--8000.hf.jobs/scopes/opaque/v1", False),
        ("https://router.huggingface.co:443/v1", False),
        ("https://router.huggingface.co:bad/v1", False),
        ("https://router.huggingface.co.evil.example/v1", False),
        ("https://abc123--8000.hf.jobs/v1", False),
        ("http://abc123--8000.hf.jobs/scopes/opaque/v1", False),
        ("http://127.0.0.1:8000/v1", False),
    ],
)
def test_hf_inference_url_validation(value: str, expected: bool) -> None:
    assert is_hf_inference_url(value) is expected


@pytest.mark.asyncio
async def test_bridge_isolates_inference_token_from_agent_environment() -> None:
    agent = RecordingAgent()
    environment = SimpleNamespace()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://abc123--8000.hf.jobs/scopes/opaque/v1",
    }

    await prepare_hf_inference_bridge(
        agent,  # type: ignore[arg-type]
        environment,  # type: ignore[arg-type]
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        inference_token="private-hf-token",
        api="chat-completions",
        allowed_model="locked-model",
        **_LIMITS,
    )

    assert env == {
        "OPENAI_API_KEY": "harbor-local-inference-bridge",
        "OPENAI_BASE_URL": "http://127.0.0.1:18080/v1",
    }
    assert len(agent.calls) == 1
    called_environment, command, root_env = agent.calls[0]
    assert called_environment is environment
    assert "private-hf-token" not in command
    assert root_env == {
        "HARBOR_HF_INFERENCE_UPSTREAM": ("https://abc123--8000.hf.jobs/scopes/opaque"),
        "HARBOR_HF_INFERENCE_TOKEN": "private-hf-token",
        "HARBOR_HF_INFERENCE_LOCAL_PORT": "18080",
        "HARBOR_HF_INFERENCE_ALLOWED_PATH": "/v1/chat/completions",
        "HARBOR_HF_INFERENCE_ALLOWED_MODEL": "locked-model",
        "HARBOR_HF_INFERENCE_MAX_REQUESTS": "256",
        "HARBOR_HF_INFERENCE_MAX_CONCURRENCY": "4",
        "HARBOR_HF_INFERENCE_TIMEOUT_SECONDS": "1800",
        "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS": "32768",
    }
    assert len(agent.agent_calls) == 1
    assert "bridge_environment_readable" in agent.agent_calls[0][1]
    assert "hf-inference-isolation.json" in agent.agent_calls[0][1]


@pytest.mark.asyncio
async def test_responses_bridge_uses_locked_limits() -> None:
    agent = RecordingAgent()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
    }

    await prepare_hf_inference_bridge(
        agent,  # type: ignore[arg-type]
        SimpleNamespace(),  # type: ignore[arg-type]
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        inference_token="private-hf-token",
        api="responses",
        allowed_model="locked-model",
        max_requests="12",
        max_concurrency="2",
        timeout_seconds="600",
        max_output_tokens="16384",
    )

    root_env = agent.calls[0][2]
    assert root_env["HARBOR_HF_INFERENCE_ALLOWED_PATH"] == "/v1/responses"
    assert root_env["HARBOR_HF_INFERENCE_ALLOWED_MODEL"] == "locked-model"
    assert root_env["HARBOR_HF_INFERENCE_MAX_REQUESTS"] == "12"
    assert root_env["HARBOR_HF_INFERENCE_MAX_CONCURRENCY"] == "2"
    assert root_env["HARBOR_HF_INFERENCE_TIMEOUT_SECONDS"] == "600"
    assert root_env["HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS"] == "16384"


@pytest.mark.asyncio
async def test_bridge_requires_token_for_an_approved_hf_route() -> None:
    agent = RecordingAgent()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
    }

    with pytest.raises(RuntimeError, match="requires an inference credential"):
        await prepare_hf_inference_bridge(
            agent,  # type: ignore[arg-type]
            SimpleNamespace(),  # type: ignore[arg-type]
            env,
            base_url_key="OPENAI_BASE_URL",
            api_key_key="OPENAI_API_KEY",
            inference_token=None,
            api="chat-completions",
            allowed_model="locked-model",
            **_LIMITS,
        )

    assert agent.calls == []


@pytest.mark.asyncio
async def test_bridge_requires_locked_limits() -> None:
    agent = RecordingAgent()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
    }

    with pytest.raises(RuntimeError, match="requires max requests"):
        await prepare_hf_inference_bridge(
            agent,  # type: ignore[arg-type]
            SimpleNamespace(),  # type: ignore[arg-type]
            env,
            base_url_key="OPENAI_BASE_URL",
            api_key_key="OPENAI_API_KEY",
            inference_token="private-hf-token",
            api="chat-completions",
            allowed_model="locked-model",
            max_requests=None,
            max_concurrency="4",
            timeout_seconds="600",
            max_output_tokens="32768",
        )

    assert agent.calls == []


@pytest.mark.asyncio
async def test_bridge_is_stopped_when_isolation_check_fails() -> None:
    agent = FailingIsolationAgent()
    env = {
        "OPENAI_API_KEY": "initial-key",
        "OPENAI_BASE_URL": "https://abc123--8000.hf.jobs/scopes/opaque/v1",
    }

    with pytest.raises(RuntimeError, match="isolation failed"):
        await prepare_hf_inference_bridge(
            agent,  # type: ignore[arg-type]
            SimpleNamespace(),  # type: ignore[arg-type]
            env,
            base_url_key="OPENAI_BASE_URL",
            api_key_key="OPENAI_API_KEY",
            inference_token="private-hf-token",
            api="chat-completions",
            allowed_model="locked-model",
            **_LIMITS,
        )

    assert len(agent.calls) == 2
    assert "kill" in agent.calls[1][1]
    assert "harbor-hf-inference-bridge.pid" in agent.calls[1][1]


@pytest.mark.asyncio
async def test_bridge_leaves_non_hf_provider_unchanged() -> None:
    agent = RecordingAgent()
    env = {
        "OPENAI_API_KEY": "provider-key",
        "OPENAI_BASE_URL": "https://api.provider.example/v1",
    }

    bridged = await prepare_hf_inference_bridge(
        agent,  # type: ignore[arg-type]
        SimpleNamespace(),  # type: ignore[arg-type]
        env,
        base_url_key="OPENAI_BASE_URL",
        api_key_key="OPENAI_API_KEY",
        inference_token=None,
        api="chat-completions",
        allowed_model="locked-model",
        max_requests=None,
        max_concurrency=None,
        timeout_seconds=None,
        max_output_tokens=None,
    )

    assert bridged is False
    assert agent.calls == []
    assert env["OPENAI_API_KEY"] == "provider-key"

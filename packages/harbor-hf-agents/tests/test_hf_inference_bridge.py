from __future__ import annotations

import inspect
import os
import socket
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from types import SimpleNamespace

import pytest

from harbor_hf_agents.support.hf_inference_bridge import (
    _run_hf_inference_bridge,
    is_hf_inference_url,
    prepare_hf_inference_bridge,
)


def test_embedded_bridge_avoids_python_312_only_typing_symbols() -> None:
    source = inspect.getsource(_run_hf_inference_bridge)

    assert "from typing import override" not in source
    assert "@override" not in source


def test_embedded_bridge_allows_bounded_streaming_overhead() -> None:
    source = inspect.getsource(_run_hf_inference_bridge)

    assert "max_output_tokens * 1024" in source
    assert "64 * 1024 * 1024" in source
    assert "inference bridge response limit exceeded" in source


def test_embedded_bridge_runs_without_module_globals() -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    script = textwrap.dedent(inspect.getsource(_run_hf_inference_bridge))
    script += "\n_run_hf_inference_bridge()\n"
    env = {
        **os.environ,
        "HARBOR_HF_INFERENCE_UPSTREAM": "https://router.huggingface.co",
        "HARBOR_HF_INFERENCE_TOKEN": "test-token",
        "HARBOR_HF_INFERENCE_LOCAL_PORT": str(port),
        "HARBOR_HF_INFERENCE_ALLOWED_PATH": "/v1/chat/completions",
        "HARBOR_HF_INFERENCE_ALLOWED_MODEL": "locked-model",
        "HARBOR_HF_INFERENCE_MAX_REQUESTS": "1",
        "HARBOR_HF_INFERENCE_MAX_CONCURRENCY": "1",
        "HARBOR_HF_INFERENCE_TIMEOUT_SECONDS": "10",
        "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS": "64",
    }
    process = subprocess.Popen(
        [sys.executable, "-c", script],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=b"{}",
        headers={"Authorization": "Bearer wrong-key"},
        method="POST",
    )
    try:
        deadline = time.monotonic() + 5
        while True:
            try:
                urllib.request.urlopen(request, timeout=0.5)  # noqa: S310
            except urllib.error.HTTPError as error:
                assert error.code == 401
                break
            except urllib.error.URLError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    stdout, stderr = process.communicate(timeout=1)
                    pytest.fail(f"bridge did not start: {stdout=} {stderr=}")
                time.sleep(0.05)
            else:
                pytest.fail("bridge accepted an invalid local API key")
    finally:
        process.terminate()
        process.wait(timeout=5)


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
    assert "harbor-hf-inference-bridge.log" in agent.calls[1][1]
    assert "/logs/agent/hf-inference-bridge.log" in agent.calls[1][1]


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

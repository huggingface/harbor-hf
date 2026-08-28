from __future__ import annotations

import inspect
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

from harbor_hf_agents.support.hf_inference_bridge import (
    _bridge_script,
    _fx_gateway_request,
    _fx_gateway_response,
    _response_usage,
    _run_hf_inference_bridge,
    _upstream_request_path,
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
    assert "request_body[field] = max_output_tokens" in source
    assert 'self.send_header("Content-Length", str(len(response_body)))' in source
    assert "inference bridge response limit exceeded" in source
    assert "BoundedThreadingHTTPServer" in source
    assert "BoundedSemaphore(max_concurrency)" in source
    assert "header_timeout_seconds = 10" in source
    assert "body_timeout_seconds = 30" in source
    assert "socket_timeout_seconds = 30" in source


@pytest.mark.parametrize(
    ("upstream_path", "request_path", "expected"),
    [
        ("", "/v1/chat/completions", "/v1/chat/completions"),
        ("/v1", "/v1/chat/completions", "/v1/chat/completions"),
        ("/v1/", "/v1/responses", "/v1/responses"),
        (
            "/scopes/opaque/v1",
            "/v1/chat/completions",
            "/scopes/opaque/v1/chat/completions",
        ),
    ],
)
def test_upstream_request_path_has_one_api_version(
    upstream_path: str,
    request_path: str,
    expected: str,
) -> None:
    assert _upstream_request_path(upstream_path, request_path) == expected


def test_fx_gateway_request_converts_messages_tools_and_limits() -> None:
    request = _fx_gateway_request(
        {
            "prompt": [
                {"role": "system", "content": "You are a coding agent."},
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "Inspect the file."}],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "I will inspect it."},
                        {
                            "type": "tool-call",
                            "toolCallId": "call-1",
                            "toolName": "read_file",
                            "input": {"path": "README.md"},
                        },
                    ],
                },
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool-result",
                            "toolCallId": "call-1",
                            "toolName": "read_file",
                            "output": {"type": "text", "value": "contents"},
                        }
                    ],
                },
            ],
            "tools": [
                {
                    "type": "function",
                    "name": "read_file",
                    "description": "Read one file.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                }
            ],
            "toolChoice": {"type": "auto"},
            "maxOutputTokens": 1024,
        },
        "Qwen/Qwen3.8-27B:deepinfra",
        32768,
    )

    assert request["model"] == "Qwen/Qwen3.8-27B:deepinfra"
    assert request["max_tokens"] == 1024
    assert request["stream"] is False
    assert request["tool_choice"] == "auto"
    assert request["messages"] == [
        {"role": "system", "content": "You are a coding agent."},
        {"role": "user", "content": "Inspect the file."},
        {
            "role": "assistant",
            "content": "I will inspect it.",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": '{"path":"README.md"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "contents"},
    ]
    assert request["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read one file.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        }
    ]


def test_fx_gateway_response_converts_text_tools_and_finish() -> None:
    response = _fx_gateway_response(
        json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": "Done.",
                            "tool_calls": [
                                {
                                    "id": "call-2",
                                    "type": "function",
                                    "function": {
                                        "name": "write_file",
                                        "arguments": '{"path":"out.txt"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4},
            }
        ).encode()
    ).decode()

    assert '"type":"text-delta","id":"text-0","delta":"Done."' in response
    assert '"type":"tool-call","toolCallId":"call-2"' in response
    assert '"toolName":"write_file","input":{"path":"out.txt"}' in response
    assert '"finishReason":{"unified":"tool-calls"}' in response
    assert '"usage":{"inputTokens":{"total":12},"outputTokens":{"total":4}}' in response
    assert response.endswith("data: [DONE]\n\n")


def test_fx_gateway_response_emits_unknown_usage_shape() -> None:
    response = _fx_gateway_response(
        json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": "Done.", "tool_calls": None},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode()
    ).decode()

    assert '"usage":{"inputTokens":{},"outputTokens":{}}' in response


def test_fx_gateway_request_unwraps_structured_tool_results() -> None:
    request = _fx_gateway_request(
        {
            "prompt": [
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool-result",
                            "toolCallId": "call-json",
                            "toolName": "read_json",
                            "output": {"type": "json", "value": {"ok": True}},
                        },
                        {
                            "type": "tool-result",
                            "toolCallId": "call-error",
                            "toolName": "read_json",
                            "output": {
                                "type": "error-json",
                                "value": {"error": "missing"},
                            },
                        },
                    ],
                }
            ],
            "tools": [],
        },
        "locked-model",
        1024,
    )

    assert request["messages"] == [
        {
            "role": "tool",
            "tool_call_id": "call-json",
            "content": '{"ok":true}',
        },
        {
            "role": "tool",
            "tool_call_id": "call-error",
            "content": '{"error":"missing"}',
        },
    ]


def test_fx_gateway_rejects_output_limit_above_lock() -> None:
    with pytest.raises(ValueError, match="output limit"):
        _fx_gateway_request(
            {
                "prompt": [{"role": "user", "content": "hello"}],
                "tools": [],
                "maxOutputTokens": 1025,
            },
            "locked-model",
            1024,
        )


def test_embedded_bridge_runs_without_module_globals(tmp_path: Path) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    script = _bridge_script()
    env = {
        **os.environ,
        "HARBOR_HF_INFERENCE_UPSTREAM": "https://router.huggingface.co/v1",
        "HARBOR_HF_INFERENCE_TOKEN": "test-token",
        "HARBOR_HF_INFERENCE_LOCAL_PORT": str(port),
        "HARBOR_HF_INFERENCE_ALLOWED_PATH": "/v1/chat/completions",
        "HARBOR_HF_INFERENCE_ALLOWED_MODEL": "locked-model",
        "HARBOR_HF_INFERENCE_MAX_REQUESTS": "1",
        "HARBOR_HF_INFERENCE_MAX_CONCURRENCY": "1",
        "HARBOR_HF_INFERENCE_TIMEOUT_SECONDS": "10",
        "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS": "64",
        "HARBOR_HF_INFERENCE_USAGE_FILE": str(tmp_path / "usage.json"),
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


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (
            json.dumps(
                {"usage": {"prompt_tokens": 12, "completion_tokens": 3}}
            ).encode(),
            (12, 3),
        ),
        (
            (
                b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
                b'data: {"choices":[],"usage":{"prompt_tokens":21,'
                b'"completion_tokens":5}}\n\ndata: [DONE]\n\n'
            ),
            (21, 5),
        ),
        (
            (
                b"event: response.completed\n"
                b'data: {"type":"response.completed","response":{"usage":'
                b'{"input_tokens":34,"output_tokens":8}}}\n\n'
            ),
            (34, 8),
        ),
        (b'{"usage":{"prompt_tokens":true,"completion_tokens":3}}', None),
        (b"data: [DONE]\n\n", None),
    ],
)
def test_extracts_trusted_provider_usage(
    body: bytes,
    expected: tuple[int, int] | None,
) -> None:
    assert _response_usage(body) == expected


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
        "HARBOR_HF_INFERENCE_USAGE_FILE": ("/tmp/harbor-hf-inference-usage.json"),
    }
    assert len(agent.agent_calls) == 1
    assert "harbor-hf-inference.token" in agent.agent_calls[0][1]
    assert "harbor-hf-inference-bridge.pid" in agent.agent_calls[0][1]


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

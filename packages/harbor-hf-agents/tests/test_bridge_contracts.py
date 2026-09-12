"""Offline protocol validation; no gateway server or inference is started."""

import json

import pytest

from harbor_hf_agents.support import fx_inference_bridge as bridge


@pytest.mark.parametrize(
    "body",
    [
        b"invalid",
        b"\xff",
        b"[]",
        b"{}",
        b'{"usage":null}',
        b'{"usage":{"input_tokens":true,"output_tokens":1}}',
        b'{"usage":{"input_tokens":1,"output_tokens":-1}}',
    ],
)
def test_invalid_usage_is_unknown(body):
    assert bridge._response_usage(body) is None


@pytest.mark.parametrize(
    "usage",
    [
        {"prompt_tokens": 2, "completion_tokens": 3},
        {"input_tokens": 2, "output_tokens": 3},
    ],
)
def test_usage_aliases_preserve_exact_counts(usage):
    assert bridge._response_usage(json.dumps({"usage": usage}).encode()) == (2, 3)


def translate(prompt, **kwargs):
    return bridge._fx_gateway_request(
        {"prompt": prompt, **kwargs}, "synthetic-model", 128
    )


def test_tool_roundtrip_translation_uses_locked_model():
    result = translate(
        [
            {"role": "system", "content": "instruction"},
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "text": "not forwarded"},
                    {"type": "text", "text": "answer"},
                    {
                        "type": "tool-call",
                        "toolCallId": "call-1",
                        "toolName": "inspect",
                        "input": {"path": "file"},
                    },
                ],
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "tool-result",
                        "toolCallId": "call-1",
                        "output": {"type": "json", "value": {"ok": True}},
                    }
                ],
            },
            {"role": "tool", "toolCallId": "call-2", "content": "plain"},
        ],
        model="untrusted-model",
        tools=[
            {
                "type": "function",
                "name": "inspect",
                "inputSchema": {"type": "object"},
                "description": "inspect file",
            }
        ],
        toolChoice={"type": "tool", "toolName": "inspect"},
    )
    assert result == {
        "model": "synthetic-model",
        "max_tokens": 128,
        "stream": False,
        "messages": [
            {"role": "system", "content": "instruction"},
            {
                "role": "assistant",
                "content": "answer",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "inspect", "arguments": '{"path":"file"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": '{"ok":true}'},
            {"role": "tool", "tool_call_id": "call-2", "content": "plain"},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "inspect",
                    "parameters": {"type": "object"},
                    "description": "inspect file",
                },
            }
        ],
        "tool_choice": {"type": "function", "function": {"name": "inspect"}},
    }


@pytest.mark.parametrize(
    "prompt,message",
    [
        ([], "non-empty array"),
        (None, "non-empty array"),
        ([None], "must be an object"),
        ([{}], "missing role"),
        ([{"role": "invalid"}], "role is invalid"),
        ([{"role": "user", "content": 1}], "message content is invalid"),
        (
            [{"role": "user", "content": [{"type": "text", "text": 1}]}],
            "text content is invalid",
        ),
        (
            [{"role": "user", "content": [{"type": "image"}]}],
            "content type is unsupported",
        ),
        (
            [{"role": "assistant", "content": [{"type": "tool-call", "input": []}]}],
            "tool input is invalid",
        ),
        ([{"role": "tool", "content": []}], "tool content is invalid"),
        ([{"role": "tool", "content": 1}], "tool content is invalid"),
        (
            [{"role": "tool", "content": [{"type": "text"}]}],
            "tool content type is invalid",
        ),
    ],
)
def test_malformed_prompts_fail_at_boundary(prompt, message):
    with pytest.raises(ValueError, match=message):
        translate(prompt)


@pytest.mark.parametrize(
    "kwargs,message",
    [
        ({"maxOutputTokens": True}, "output limit"),
        ({"maxOutputTokens": 0}, "output limit"),
        ({"maxOutputTokens": 129}, "output limit"),
        ({"maxOutputTokens": 1.5}, "output limit"),
        ({"tools": {}}, "tools must be an array"),
        ({"tools": [{"type": "invalid"}]}, "tool type is invalid"),
        (
            {"tools": [{"type": "function", "name": "", "inputSchema": {}}]},
            "tool definition is invalid",
        ),
        (
            {"tools": [{"type": "function", "name": "inspect", "inputSchema": []}]},
            "tool definition is invalid",
        ),
    ],
)
def test_invalid_limits_and_tools_fail_closed(kwargs, message):
    with pytest.raises(ValueError, match=message):
        translate([{"role": "user", "content": "hello"}], **kwargs)


@pytest.mark.parametrize(
    "choice",
    [
        {"type": "invalid"},
        {"type": "tool", "toolName": ""},
        {"type": "tool", "toolName": 1},
    ],
)
def test_invalid_tool_choice_rejected(choice):
    with pytest.raises(ValueError, match="tool choice is invalid"):
        translate(
            [{"role": "user"}],
            tools=[{"type": "function", "name": "inspect", "inputSchema": {}}],
            toolChoice=choice,
        )


@pytest.mark.parametrize(
    "message,error",
    [
        ({"tool_calls": {}}, "tool calls are invalid"),
        (
            {
                "tool_calls": [
                    {"id": 1, "function": {"name": "inspect", "arguments": "{}"}}
                ]
            },
            "tool call fields are invalid",
        ),
        (
            {
                "tool_calls": [
                    {"id": "call-1", "function": {"name": "inspect", "arguments": "[]"}}
                ]
            },
            "tool input must be an object",
        ),
    ],
)
def test_invalid_response_tools_rejected(message, error):
    with pytest.raises(ValueError, match=error):
        bridge._fx_gateway_response(
            json.dumps({"choices": [{"message": message}]}).encode()
        )


@pytest.mark.parametrize(
    "reason,expected",
    [
        ("stop", "stop"),
        ("length", "length"),
        ("content_filter", "error"),
        ("tool_calls", "tool-calls"),
    ],
)
def test_finish_reason_translated_without_fabricated_usage(reason, expected):
    body = bridge._fx_gateway_response(
        json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": "answer", "tool_calls": None},
                        "finish_reason": reason,
                    }
                ]
            }
        ).encode()
    )
    events = [
        json.loads(line.removeprefix("data: "))
        for line in body.decode().splitlines()
        if line.startswith("data: {")
    ]
    assert events[0] == {"type": "text-start", "id": "text-0"}
    assert {"type": "text-delta", "id": "text-0", "delta": "answer"} in events
    assert events[-1]["finishReason"] == {"unified": expected}
    assert events[-1]["usage"] == {"inputTokens": {}, "outputTokens": {}}

"""Bounded FX gateway translation over the locked Hugging Face route."""

from __future__ import annotations

import inspect
import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment

_LOCAL_API_KEY = "harbor-local-fx-bridge"
_LOCAL_PORT = 18080
_BRIDGE_DIR = Path("/run/harbor-hf-fx")
_BRIDGE_PID_PATH = _BRIDGE_DIR / "bridge.pid"
_BRIDGE_TOKEN_PATH = _BRIDGE_DIR / "inference.token"
_BRIDGE_USAGE_PATH = _BRIDGE_DIR / "usage.json"
_BRIDGE_LOG_PATH = _BRIDGE_DIR / "bridge.log"
_BRIDGE_MARKER = "harbor-hf-fx-bridge-v1"
_FX_GATEWAY_PATH = "/v3/ai/language-model"
_HF_ROUTER_URL = "https://router.huggingface.co/v1"
_MAX_REQUESTS = 512
_MAX_CONCURRENCY = 4
_MAX_OUTPUT_TOKENS = 32768


@dataclass(frozen=True)
class FxInferenceUsage:
    """Token totals reported by the local FX bridge."""

    requests: int
    input_tokens: int
    output_tokens: int


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return cast(dict[str, object], value)


def _value(mapping: dict[str, object], key: str, label: str) -> object:
    try:
        return mapping[key]
    except KeyError as error:
        raise ValueError(f"{label} is missing {key}") from error


def _optional(mapping: dict[str, object], key: str, default: object) -> object:
    if key in mapping:
        return mapping[key]
    return default


def _usage_pair(value: object) -> tuple[int, int] | None:
    if not isinstance(value, dict):
        return None
    usage = cast(dict[str, object], value)
    if "prompt_tokens" in usage and "completion_tokens" in usage:
        input_value = usage["prompt_tokens"]
        output_value = usage["completion_tokens"]
    elif "input_tokens" in usage and "output_tokens" in usage:
        input_value = usage["input_tokens"]
        output_value = usage["output_tokens"]
    else:
        return None
    if (
        isinstance(input_value, bool)
        or not isinstance(input_value, int)
        or input_value < 0
        or isinstance(output_value, bool)
        or not isinstance(output_value, int)
        or output_value < 0
    ):
        return None
    return input_value, output_value


def _response_usage(body: bytes) -> tuple[int, int] | None:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if "usage" not in payload:
        return None
    return _usage_pair(payload["usage"])


def _fx_gateway_request(  # noqa: C901 -- strict protocol translation
    payload: object,
    allowed_model: str,
    max_output_tokens: int,
) -> dict[str, object]:
    """Translate one FX AI SDK request to OpenAI Chat Completions."""
    request = _object(payload, "FX gateway request")
    prompt_value = _value(request, "prompt", "FX gateway request")
    if not isinstance(prompt_value, list) or not prompt_value:
        raise ValueError("FX gateway prompt must be a non-empty array")

    messages: list[dict[str, object]] = []
    for raw_message in prompt_value:
        message = _object(raw_message, "FX gateway message")
        role = _value(message, "role", "FX gateway message")
        if role not in {"system", "user", "assistant", "tool"}:
            raise ValueError("FX gateway message role is invalid")
        content = _optional(message, "content", "")

        if role == "tool":
            if isinstance(content, str):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": _optional(message, "toolCallId", ""),
                        "content": content,
                    }
                )
                continue
            if not isinstance(content, list) or not content:
                raise ValueError("FX gateway tool content is invalid")
            for raw_part in content:
                part = _object(raw_part, "FX gateway tool content")
                if _value(part, "type", "FX gateway tool content") != "tool-result":
                    raise ValueError("FX gateway tool content type is invalid")
                output = _optional(part, "output", "")
                if isinstance(output, dict):
                    output_object = cast(dict[str, object], output)
                    if "value" in output_object and output_object["type"] in {
                        "text",
                        "json",
                        "error-text",
                        "error-json",
                    }:
                        output = output_object["value"]
                if not isinstance(output, str):
                    output = json.dumps(
                        output,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": _optional(part, "toolCallId", ""),
                        "content": output,
                    }
                )
            continue

        text_parts: list[str] = []
        tool_calls: list[dict[str, object]] = []
        if isinstance(content, str):
            text_parts.append(content)
        elif isinstance(content, list):
            for raw_part in content:
                part = _object(raw_part, "FX gateway content")
                part_type = _value(part, "type", "FX gateway content")
                if part_type in {"text", "reasoning"}:
                    text = _optional(part, "text", "")
                    if not isinstance(text, str):
                        raise ValueError("FX gateway text content is invalid")
                    if part_type == "text":
                        text_parts.append(text)
                elif part_type == "tool-call" and role == "assistant":
                    tool_input = _optional(part, "input", {})
                    if not isinstance(tool_input, dict):
                        raise ValueError("FX gateway tool input is invalid")
                    tool_calls.append(
                        {
                            "id": _value(part, "toolCallId", "FX gateway tool call"),
                            "type": "function",
                            "function": {
                                "name": _value(
                                    part, "toolName", "FX gateway tool call"
                                ),
                                "arguments": json.dumps(
                                    tool_input,
                                    separators=(",", ":"),
                                    ensure_ascii=False,
                                ),
                            },
                        }
                    )
                else:
                    raise ValueError("FX gateway content type is unsupported")
        else:
            raise ValueError("FX gateway message content is invalid")

        translated: dict[str, object] = {
            "role": role,
            "content": "".join(text_parts),
        }
        if tool_calls:
            translated["tool_calls"] = tool_calls
        messages.append(translated)

    output_limit = _optional(request, "maxOutputTokens", max_output_tokens)
    if (
        isinstance(output_limit, bool)
        or not isinstance(output_limit, int)
        or output_limit < 1
        or output_limit > max_output_tokens
    ):
        raise ValueError("FX gateway output limit is invalid")

    translated_request: dict[str, object] = {
        "model": allowed_model,
        "messages": messages,
        "max_tokens": output_limit,
        "stream": False,
    }
    raw_tools = _optional(request, "tools", [])
    if not isinstance(raw_tools, list):
        raise ValueError("FX gateway tools must be an array")
    tools: list[dict[str, object]] = []
    for raw_tool in raw_tools:
        tool = _object(raw_tool, "FX gateway tool")
        if _value(tool, "type", "FX gateway tool") != "function":
            raise ValueError("FX gateway tool type is invalid")
        name = _value(tool, "name", "FX gateway tool")
        schema = _value(tool, "inputSchema", "FX gateway tool")
        if not isinstance(name, str) or not name or not isinstance(schema, dict):
            raise ValueError("FX gateway tool definition is invalid")
        function: dict[str, object] = {
            "name": name,
            "parameters": schema,
        }
        description = _optional(tool, "description", None)
        if isinstance(description, str):
            function["description"] = description
        tools.append({"type": "function", "function": function})
    if tools:
        translated_request["tools"] = tools
        choice = _optional(request, "toolChoice", {"type": "auto"})
        choice_object = _object(choice, "FX gateway tool choice")
        choice_type = _value(choice_object, "type", "FX gateway tool choice")
        if choice_type in {"auto", "none", "required"}:
            translated_request["tool_choice"] = choice_type
        elif choice_type == "tool":
            tool_name = _value(choice_object, "toolName", "FX gateway tool choice")
            if not isinstance(tool_name, str) or not tool_name:
                raise ValueError("FX gateway tool choice is invalid")
            translated_request["tool_choice"] = {
                "type": "function",
                "function": {"name": tool_name},
            }
        else:
            raise ValueError("FX gateway tool choice is invalid")
    return translated_request


def _fx_gateway_response(body: bytes) -> bytes:  # noqa: C901 -- strict protocol translation
    """Translate one OpenAI response to the FX gateway event stream."""
    payload = json.loads(body)
    response = _object(payload, "OpenAI response")
    choices = _value(response, "choices", "OpenAI response")
    if not isinstance(choices, list) or not choices:
        raise ValueError("OpenAI response choices are invalid")
    choice = _object(choices[0], "OpenAI response choice")
    message = _object(
        _value(choice, "message", "OpenAI response choice"), "OpenAI message"
    )

    events: list[dict[str, object]] = []
    content = _optional(message, "content", "")
    if isinstance(content, str) and content:
        events.extend(
            [
                {"type": "text-start", "id": "text-0"},
                {"type": "text-delta", "id": "text-0", "delta": content},
                {"type": "text-end", "id": "text-0"},
            ]
        )

    raw_tool_calls = _optional(message, "tool_calls", [])
    if raw_tool_calls is None:
        raw_tool_calls = []
    if not isinstance(raw_tool_calls, list):
        raise ValueError("OpenAI tool calls are invalid")
    for raw_tool_call in raw_tool_calls:
        tool_call = _object(raw_tool_call, "OpenAI tool call")
        function = _object(
            _value(tool_call, "function", "OpenAI tool call"),
            "OpenAI tool function",
        )
        arguments = _value(function, "arguments", "OpenAI tool function")
        if (
            not isinstance(_value(tool_call, "id", "OpenAI tool call"), str)
            or not isinstance(_value(function, "name", "OpenAI tool function"), str)
            or not isinstance(arguments, str)
        ):
            raise ValueError("OpenAI tool call fields are invalid")
        parsed_arguments = json.loads(arguments)
        if not isinstance(parsed_arguments, dict):
            raise ValueError("OpenAI tool input must be an object")
        events.append(
            {
                "type": "tool-call",
                "toolCallId": _value(tool_call, "id", "OpenAI tool call"),
                "toolName": _value(function, "name", "OpenAI tool function"),
                "input": parsed_arguments,
            }
        )

    finish_reason = _optional(choice, "finish_reason", "stop")
    if finish_reason == "tool_calls":
        unified_reason = "tool-calls"
    elif finish_reason == "length":
        unified_reason = "length"
    elif finish_reason == "content_filter":
        unified_reason = "error"
    else:
        unified_reason = "stop"
    usage = _optional(response, "usage", None)
    usage_event: dict[str, dict[str, int]] = {
        "inputTokens": {},
        "outputTokens": {},
    }
    usage_pair = _usage_pair(usage)
    if usage_pair is not None:
        usage_event = {
            "inputTokens": {"total": usage_pair[0]},
            "outputTokens": {"total": usage_pair[1]},
        }
    events.append(
        {
            "type": "finish",
            "finishReason": {"unified": unified_reason},
            "usage": usage_event,
        }
    )
    return (
        b"".join(
            b"data: "
            + json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode()
            + b"\n\n"
            for event in events
        )
        + b"data: [DONE]\n\n"
    )


def _bridge_script() -> str:
    """Build the isolated Python program executed inside each task sandbox."""
    source = [
        f"# {_BRIDGE_MARKER}",
        "from __future__ import annotations",
        "import json",
        "import os",
        "from typing import cast",
        f"_FX_GATEWAY_PATH = {_FX_GATEWAY_PATH!r}",
        f"_LOCAL_API_KEY = {_LOCAL_API_KEY!r}",
        inspect.getsource(_object),
        inspect.getsource(_value),
        inspect.getsource(_optional),
        inspect.getsource(_usage_pair),
        inspect.getsource(_fx_gateway_request),
        inspect.getsource(_fx_gateway_response),
        inspect.getsource(_response_usage),
        inspect.getsource(_run_bridge),
        "_run_bridge()",
    ]
    return "\n\n".join(source) + "\n"


def _run_bridge() -> None:  # noqa: C901 -- isolated bridge server
    """Serve FX requests and translate them to locked OpenAI Chat Completions."""
    import http.client
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlsplit

    upstream = urlsplit(os.environ["HARBOR_FX_BRIDGE_UPSTREAM"])
    upstream_host = upstream.hostname
    if upstream.scheme != "https" or upstream_host is None:
        raise RuntimeError("FX bridge upstream is not an HTTPS host")
    token_path = os.environ["HARBOR_FX_BRIDGE_TOKEN_FILE"]
    with open(token_path, encoding="utf-8") as token_handle:
        token = token_handle.read().strip()
    os.unlink(token_path)
    allowed_model = os.environ["HARBOR_FX_BRIDGE_MODEL"]
    usage_path = os.environ["HARBOR_FX_BRIDGE_USAGE_FILE"]
    port = int(os.environ["HARBOR_FX_BRIDGE_PORT"])
    max_requests = int(os.environ["HARBOR_FX_BRIDGE_MAX_REQUESTS"])
    max_concurrency = int(os.environ["HARBOR_FX_BRIDGE_MAX_CONCURRENCY"])
    timeout_seconds = int(os.environ["HARBOR_FX_BRIDGE_TIMEOUT_SECONDS"])
    max_output_tokens = int(os.environ["HARBOR_FX_BRIDGE_MAX_OUTPUT_TOKENS"])
    base_path = upstream.path.rstrip("/")
    if base_path.endswith("/v1"):
        base_path = base_path[:-3]
    upstream_path = f"{base_path}/v1/chat/completions"
    request_lock = threading.Lock()
    usage_lock = threading.Lock()
    request_count = 0
    usage_requests = 0
    input_tokens = 0
    output_tokens = 0

    def write_usage() -> None:
        payload = (
            json.dumps(
                {
                    "schema_version": "v1",
                    "requests": usage_requests,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        temporary = f"{usage_path}.tmp"
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_NOFOLLOW | os.O_TRUNC | os.O_WRONLY,
            0o644,
        )
        try:
            os.write(descriptor, payload)
            os.fchmod(descriptor, 0o644)
        finally:
            os.close(descriptor)
        os.replace(temporary, usage_path)

    def record_usage(usage: tuple[int, int] | None) -> None:
        nonlocal usage_requests, input_tokens, output_tokens
        with usage_lock:
            usage_requests += 1
            if usage is not None:
                input_tokens += usage[0]
                output_tokens += usage[1]
            write_usage()

    write_usage()

    class BoundedServer(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = max(1, min(max_concurrency, 64))

        def __init__(
            self,
            server_address: tuple[str, int],
            request_handler_class: type[BaseHTTPRequestHandler],
        ) -> None:
            self.slots = threading.BoundedSemaphore(max_concurrency)
            super().__init__(server_address, request_handler_class)

        def process_request(
            self,
            request: Any,  # noqa: ANN401 -- mirrors socketserver
            client_address: Any,  # noqa: ANN401 -- mirrors socketserver
        ) -> None:
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except BaseException:
                self.slots.release()
                raise

        def process_request_thread(
            self,
            request: Any,  # noqa: ANN401 -- mirrors socketserver
            client_address: Any,  # noqa: ANN401 -- mirrors socketserver
        ) -> None:
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.slots.release()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:  # noqa: C901 -- bounded request parser
            nonlocal request_count
            self.close_connection = True
            if self.path != _FX_GATEWAY_PATH:
                self.send_error(404)
                return
            if self.headers["Authorization"] != f"Bearer {_LOCAL_API_KEY}":
                self.send_error(401)
                return
            with request_lock:
                if request_count >= max_requests:
                    self.send_error(429)
                    return
                request_count += 1
            try:
                length = int(self.headers["Content-Length"])
            except (KeyError, TypeError, ValueError):
                self.send_error(400)
                return
            if length < 0 or length > 64 * 1024 * 1024:
                self.send_error(413)
                return
            try:
                body = self.rfile.read(length)
            except TimeoutError:
                self.send_error(408)
                return
            if len(body) != length:
                self.send_error(400)
                return
            try:
                request_body = json.loads(body)
                translated = _fx_gateway_request(
                    request_body,
                    allowed_model,
                    max_output_tokens,
                )
                encoded = json.dumps(
                    translated,
                    separators=(",", ":"),
                    ensure_ascii=False,
                ).encode()
            except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
                self.send_error(400)
                return
            connection = http.client.HTTPSConnection(
                upstream_host,
                upstream.port or 443,
                timeout=timeout_seconds,
            )
            try:
                connection.request(
                    "POST",
                    upstream_path,
                    body=encoded,
                    headers={
                        "Accept": "application/json",
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                )
                response = connection.getresponse()
                response_body = response.read(64 * 1024 * 1024 + 1)
                if len(response_body) > 64 * 1024 * 1024:
                    self.send_error(502)
                    return
                if not 200 <= response.status < 300:
                    self.send_response(response.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response_body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(response_body)
                    return
                record_usage(_response_usage(response_body))
                output = _fx_gateway_response(response_body)
                self.send_response(200)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(output)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(output)
                self.wfile.flush()
            except (OSError, http.client.HTTPException, ValueError):
                self.send_error(502)
            finally:
                connection.close()

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    BoundedServer(("127.0.0.1", port), Handler).serve_forever()


def _start_command(script: str) -> str:
    """Return a root command that starts and health-checks the bridge."""
    quoted_script = shlex.quote(script)
    bridge_dir = shlex.quote(str(_BRIDGE_DIR))
    pid_path = shlex.quote(str(_BRIDGE_PID_PATH))
    token_path = shlex.quote(str(_BRIDGE_TOKEN_PATH))
    usage_path = shlex.quote(str(_BRIDGE_USAGE_PATH))
    log_path = shlex.quote(str(_BRIDGE_LOG_PATH))
    temporary_usage_path = shlex.quote(str(_BRIDGE_USAGE_PATH) + ".tmp")
    pid_guard = (
        "bridge_pid_is_current() { "
        '[ -r "/proc/$1/cmdline" ] || return 1; '
        r"""case "$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)" in """
        f"*{_BRIDGE_MARKER}*) return 0 ;; "
        "*) return 1 ;; "
        "esac; "
        "}"
    )
    stop_existing = (
        f"if [ -f {pid_path} ]; then "
        f"pid=$(cat {pid_path}); "
        'if bridge_pid_is_current "$pid"; then '
        'kill "$pid" 2>/dev/null || true; '
        "for attempt in $(seq 1 20); do "
        'if ! kill -0 "$pid" 2>/dev/null; then break; fi; sleep 0.1; '
        "done; "
        'if kill -0 "$pid" 2>/dev/null; then '
        'kill -KILL "$pid" 2>/dev/null || true; '
        "fi; "
        "fi; "
        "fi; "
    )
    readiness = shlex.quote(
        "import socket,time\n"
        "deadline=time.monotonic()+10\n"
        "while time.monotonic()<deadline:\n"
        "  try:\n"
        f"    with socket.create_connection("
        f"('127.0.0.1',{_LOCAL_PORT}),timeout=.25): break\n"
        "  except OSError: time.sleep(.1)\n"
        "else: raise SystemExit('FX bridge did not become ready')"
    )
    return (
        "set -euo pipefail; "
        f"{pid_guard}; "
        f"if [ -L {bridge_dir} ] || "
        f"{{ [ -e {bridge_dir} ] && [ ! -d {bridge_dir} ]; }}; then exit 1; fi; "
        f"install -d -m 0700 -o root -g root {bridge_dir}; "
        f"{stop_existing}"
        f"rm -f {pid_path} {token_path} {usage_path} {log_path} "
        f"{temporary_usage_path}; "
        f"umask 077; printf '%s' \"$HARBOR_FX_BRIDGE_TOKEN\" > "
        f"{token_path}; "
        f"nohup env -u HARBOR_FX_BRIDGE_TOKEN python3 -c {quoted_script} "
        f"> {log_path} 2>&1 & "
        'bridge_pid="$!"; '
        f'printf "%s" "$bridge_pid" > {pid_path}; '
        f"if ! python3 -c {readiness}; then "
        'if bridge_pid_is_current "$bridge_pid"; then '
        'kill "$bridge_pid" 2>/dev/null || true; '
        'wait "$bridge_pid" 2>/dev/null || true; '
        "fi; "
        f"rm -f {pid_path} {token_path} {usage_path} "
        f"{temporary_usage_path} {log_path}; "
        "exit 1; "
        "fi"
    )


def _stop_command() -> str:
    """Return a root command that stops the bridge and emits safe usage data."""
    pid_guard = (
        "bridge_pid_is_current() { "
        '[ -r "/proc/$1/cmdline" ] || return 1; '
        r"""case "$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)" in """
        f"*{_BRIDGE_MARKER}*) return 0 ;; "
        "*) return 1 ;; "
        "esac; "
        "}"
    )
    pid_path = shlex.quote(str(_BRIDGE_PID_PATH))
    token_path = shlex.quote(str(_BRIDGE_TOKEN_PATH))
    usage_path = shlex.quote(str(_BRIDGE_USAGE_PATH))
    log_path = shlex.quote(str(_BRIDGE_LOG_PATH))
    temporary_usage_path = shlex.quote(str(_BRIDGE_USAGE_PATH) + ".tmp")
    return (
        "set -euo pipefail; "
        f"{pid_guard}; "
        f"if [ -f {pid_path} ]; then "
        f"pid=$(cat {pid_path}); "
        'if bridge_pid_is_current "$pid"; then '
        'kill "$pid" 2>/dev/null || true; '
        "for attempt in $(seq 1 20); do "
        'if ! kill -0 "$pid" 2>/dev/null; then break; fi; sleep 0.1; '
        "done; "
        'if kill -0 "$pid" 2>/dev/null; then '
        'kill -KILL "$pid" 2>/dev/null || true; '
        "fi; "
        "fi; "
        "fi; "
        f"rm -f {pid_path} {token_path}; "
        f"if [ -f {usage_path} ]; then cat {usage_path}; fi; "
        f"if [ -f {log_path} ]; then "
        f"install -m 0644 {log_path} /logs/agent/fx-inference-bridge.log; fi; "
        f"rm -f {usage_path} {temporary_usage_path} "
        f"{log_path}"
    )


def _parse_usage(value: str) -> FxInferenceUsage | None:
    for line in reversed(value.splitlines()):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        record = cast(dict[str, object], parsed)
        if set(record) != {
            "schema_version",
            "requests",
            "input_tokens",
            "output_tokens",
        }:
            continue
        requests = record["requests"]
        input_tokens = record["input_tokens"]
        output_tokens = record["output_tokens"]
        if record["schema_version"] != "v1" or any(
            isinstance(item, bool) or not isinstance(item, int) or item < 0
            for item in (requests, input_tokens, output_tokens)
        ):
            continue
        if (
            not isinstance(requests, int)
            or not isinstance(input_tokens, int)
            or not isinstance(output_tokens, int)
        ):
            continue
        return FxInferenceUsage(
            requests=requests,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
    return None


def _validate_upstream(upstream: str) -> None:
    parsed = urlsplit(upstream)
    if (
        upstream != _HF_ROUTER_URL
        or parsed.scheme != "https"
        or parsed.hostname != "router.huggingface.co"
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("FX requires the locked Hugging Face router route")


async def start_fx_bridge(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
    *,
    upstream: str,
    token: str,
    model: str,
) -> None:
    """Start a root-owned local FX gateway bridge for one trial."""
    _validate_upstream(upstream)
    if not token:
        raise RuntimeError("HF_INFERENCE_TOKEN is required for FX")
    if not model:
        raise RuntimeError("FX model name is required")
    await agent.exec_as_root(
        environment,
        command=_start_command(_bridge_script()),
        env={
            "HARBOR_FX_BRIDGE_UPSTREAM": upstream,
            "HARBOR_FX_BRIDGE_TOKEN": token,
            "HARBOR_FX_BRIDGE_TOKEN_FILE": str(_BRIDGE_TOKEN_PATH),
            "HARBOR_FX_BRIDGE_MODEL": model,
            "HARBOR_FX_BRIDGE_PORT": str(_LOCAL_PORT),
            "HARBOR_FX_BRIDGE_MAX_REQUESTS": str(_MAX_REQUESTS),
            "HARBOR_FX_BRIDGE_MAX_CONCURRENCY": str(_MAX_CONCURRENCY),
            "HARBOR_FX_BRIDGE_TIMEOUT_SECONDS": "1800",
            "HARBOR_FX_BRIDGE_MAX_OUTPUT_TOKENS": str(_MAX_OUTPUT_TOKENS),
            "HARBOR_FX_BRIDGE_USAGE_FILE": str(_BRIDGE_USAGE_PATH),
        },
    )


async def stop_fx_bridge(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
) -> FxInferenceUsage | None:
    """Stop the bridge and return its non-secret token usage record."""
    result = await agent.exec_as_root(
        environment,
        command=_stop_command(),
    )
    stdout = getattr(result, "stdout", "")
    if not isinstance(stdout, str):
        return None
    return _parse_usage(stdout)

"""Root-owned bridge for approved Hugging Face inference credentials."""

from __future__ import annotations

import inspect
import re
import shlex
from contextlib import suppress
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlsplit, urlunsplit

if TYPE_CHECKING:
    from harbor.agents.installed.base import BaseInstalledAgent
    from harbor.environments.base import BaseEnvironment

_HF_JOBS_HOST = re.compile(r"^[a-z0-9-]+\.hf\.jobs$")
_HF_ENDPOINT_HOST = re.compile(
    r"^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.endpoints\.huggingface\.cloud$"
)
_HF_ROUTER_HOST = "router.huggingface.co"
_LOCAL_API_KEY = "harbor-local-inference-bridge"


def _run_hf_inference_bridge() -> None:  # noqa: C901 -- isolated bridge parser
    """Run as root inside the Sandbox and inject the inference credential."""
    import http.client
    import json
    import os
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlsplit

    upstream = urlsplit(os.environ["HARBOR_HF_INFERENCE_UPSTREAM"])
    upstream_host = upstream.hostname
    if upstream_host is None:
        raise RuntimeError("Hugging Face inference upstream host is missing")
    token = os.environ["HARBOR_HF_INFERENCE_TOKEN"]
    port = int(os.environ["HARBOR_HF_INFERENCE_LOCAL_PORT"])
    allowed_path = os.environ["HARBOR_HF_INFERENCE_ALLOWED_PATH"]
    allowed_model = os.environ["HARBOR_HF_INFERENCE_ALLOWED_MODEL"]
    max_requests = int(os.environ["HARBOR_HF_INFERENCE_MAX_REQUESTS"])
    max_concurrency = int(os.environ["HARBOR_HF_INFERENCE_MAX_CONCURRENCY"])
    timeout_seconds = int(os.environ["HARBOR_HF_INFERENCE_TIMEOUT_SECONDS"])
    max_output_tokens = int(os.environ["HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS"])
    max_response_bytes = min(64 * 1024 * 1024, 1024 * 1024 + max_output_tokens * 32)
    local_api_key = "harbor-local-inference-bridge"
    base_path = upstream.path.rstrip("/")
    admission = threading.BoundedSemaphore(max_concurrency)
    counter_lock = threading.Lock()
    request_count = 0

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:  # noqa: C901 -- isolated bridge parser
            nonlocal request_count
            if self.path != allowed_path:
                self.send_error(404)
                return
            if self.headers.get("Authorization") != f"Bearer {local_api_key}":
                self.send_error(401)
                return
            if not admission.acquire(blocking=False):
                self.send_error(429)
                return
            try:
                with counter_lock:
                    if request_count >= max_requests:
                        self.send_error(429)
                        return
                    request_count += 1
                try:
                    length = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    self.send_error(400)
                    return
                if length < 0 or length > 64 * 1024 * 1024:
                    self.send_error(413)
                    return
                body = self.rfile.read(length)
                try:
                    request_body = json.loads(body)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self.send_error(400)
                    return
                if (
                    not isinstance(request_body, dict)
                    or request_body.get("model") != allowed_model
                ):
                    self.send_error(403)
                    return
                for field in (
                    "max_tokens",
                    "max_completion_tokens",
                    "max_output_tokens",
                ):
                    value = request_body.get(field)
                    if value is not None and (
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value < 1
                        or value > max_output_tokens
                    ):
                        self.send_error(403)
                        return
                connection = http.client.HTTPSConnection(
                    upstream_host, 443, timeout=timeout_seconds
                )
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Content-Type": self.headers.get(
                        "Content-Type", "application/json"
                    ),
                    "Accept": self.headers.get("Accept", "application/json"),
                }
                try:
                    connection.request(
                        "POST", base_path + self.path, body=body, headers=headers
                    )
                    response = connection.getresponse()
                    self.send_response(response.status)
                    for name, value in response.getheaders():
                        if name.lower() in {
                            "content-type",
                            "cache-control",
                            "x-request-id",
                            "request-id",
                        }:
                            self.send_header(name, value)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    response_size = 0
                    while chunk := response.read(64 * 1024):
                        response_size += len(chunk)
                        if response_size > max_response_bytes:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (OSError, http.client.HTTPException):
                    if not self.wfile.closed:
                        payload = json.dumps(
                            {"error": "inference bridge transport failed"}
                        ).encode()
                        self.send_response(502)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(payload)
                finally:
                    connection.close()
                    self.close_connection = True
            finally:
                admission.release()

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def _bridge_command() -> str:
    body = inspect.getsource(_run_hf_inference_bridge)
    script = body + "\n_run_hf_inference_bridge()\n"
    return (
        "set -euo pipefail; "
        "if [ -f /tmp/harbor-hf-inference-bridge.pid ]; then "
        "old_pid=$(cat /tmp/harbor-hf-inference-bridge.pid); "
        'kill "$old_pid" 2>/dev/null || true; '
        "rm -f /tmp/harbor-hf-inference-bridge.pid; fi; "
        "rm -f /tmp/harbor-hf-inference-bridge.ready; "
        f"nohup python3 -c {shlex.quote(script)} "
        ">/tmp/harbor-hf-inference-bridge.log 2>&1 & "
        "pid=$!; printf '%s\\n' \"$pid\" "
        ">/tmp/harbor-hf-inference-bridge.pid; "
        "chmod 0444 /tmp/harbor-hf-inference-bridge.pid; "
        "python3 - <<'PY'\n"
        "import os, socket, time\n"
        "port = int(os.environ['HARBOR_HF_INFERENCE_LOCAL_PORT'])\n"
        "deadline = time.monotonic() + 10\n"
        "while True:\n"
        "    try:\n"
        "        with socket.create_connection(('127.0.0.1', port), timeout=0.25):\n"
        "            break\n"
        "    except OSError:\n"
        "        if time.monotonic() >= deadline:\n"
        "            raise SystemExit('HF inference bridge did not become ready')\n"
        "        time.sleep(0.1)\n"
        "PY\n"
    )


def is_hf_inference_url(value: str) -> bool:
    """Return whether *value* is an approved Hugging Face inference URL."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return False
    if (
        parsed.scheme != "https"
        or host is None
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return False
    if host == _HF_ROUTER_HOST:
        return parsed.path.rstrip("/") in {"", "/v1"}
    if _HF_JOBS_HOST.fullmatch(host) is not None:
        return "/scopes/" in parsed.path
    return _HF_ENDPOINT_HOST.fullmatch(host) is not None and parsed.path.rstrip(
        "/"
    ) in {"", "/v1"}


def _positive_limit(value: str | None, name: str, maximum: int) -> int:
    if value is None:
        raise RuntimeError(f"HF inference bridging requires {name}")
    try:
        parsed = int(value)
    except ValueError as error:
        raise RuntimeError(f"HF inference bridge {name} is invalid") from error
    if parsed < 1 or parsed > maximum:
        raise RuntimeError(f"HF inference bridge {name} is out of range")
    return parsed


async def prepare_hf_inference_bridge(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
    env: dict[str, str],
    *,
    base_url_key: str,
    api_key_key: str,
    inference_token: str | None,
    api: Literal["chat-completions", "responses"],
    allowed_model: str,
    max_requests: str | None,
    max_concurrency: str | None,
    timeout_seconds: str | None,
    max_output_tokens: str | None,
    local_port: int = 18080,
) -> bool:
    """Replace an approved HF URL with a root-owned loopback bridge."""
    base_url = env.get(base_url_key, "")
    if not is_hf_inference_url(base_url):
        return False
    if not inference_token:
        raise RuntimeError("HF inference bridging requires an inference credential")
    if not allowed_model:
        raise RuntimeError("HF inference bridging requires a locked model")
    request_limit = _positive_limit(max_requests, "max requests", 4096)
    concurrency_limit = _positive_limit(max_concurrency, "max concurrency", 64)
    timeout_limit = _positive_limit(timeout_seconds, "timeout", 3600)
    output_limit = _positive_limit(max_output_tokens, "max output tokens", 1048576)
    parsed = urlsplit(base_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    upstream = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
    allowed_path = (
        "/v1/chat/completions" if api == "chat-completions" else "/v1/responses"
    )
    await agent.exec_as_root(
        environment,
        command=_bridge_command(),
        env={
            "HARBOR_HF_INFERENCE_UPSTREAM": upstream,
            "HARBOR_HF_INFERENCE_TOKEN": inference_token,
            "HARBOR_HF_INFERENCE_LOCAL_PORT": str(local_port),
            "HARBOR_HF_INFERENCE_ALLOWED_PATH": allowed_path,
            "HARBOR_HF_INFERENCE_ALLOWED_MODEL": allowed_model,
            "HARBOR_HF_INFERENCE_MAX_REQUESTS": str(request_limit),
            "HARBOR_HF_INFERENCE_MAX_CONCURRENCY": str(concurrency_limit),
            "HARBOR_HF_INFERENCE_TIMEOUT_SECONDS": str(timeout_limit),
            "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS": str(output_limit),
        },
    )
    env[base_url_key] = f"http://127.0.0.1:{local_port}/v1"
    env[api_key_key] = _LOCAL_API_KEY
    try:
        await verify_hf_inference_isolation(agent, environment)
    except BaseException:
        with suppress(Exception):
            await stop_hf_inference_bridge(agent, environment)
        raise
    return True


async def verify_hf_inference_isolation(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
) -> None:
    """Prove that the agent user cannot inspect the bridge credential state."""
    await agent.exec_as_agent(
        environment,
        command=(
            "set -euo pipefail; "
            "pid=$(cat /tmp/harbor-hf-inference-bridge.pid); "
            "agent_uid=$(id -u); bridge_uid=$(stat -c %u /proc/$pid); "
            'test "$agent_uid" != "$bridge_uid"; '
            "if cat /proc/$pid/environ >/dev/null 2>&1; then exit 1; fi; "
            'printf \'{"agent_uid":%s,"bridge_uid":%s,'
            '"bridge_environment_readable":false}\\n\' '
            '"$agent_uid" "$bridge_uid" '
            ">/logs/agent/hf-inference-isolation.json"
        ),
    )


async def stop_hf_inference_bridge(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
) -> None:
    """Stop the trial-local bridge and remove its process handle."""
    await agent.exec_as_root(
        environment,
        command=(
            "set -euo pipefail; "
            "if [ -f /tmp/harbor-hf-inference-bridge.pid ]; then "
            "pid=$(cat /tmp/harbor-hf-inference-bridge.pid); "
            'kill "$pid" 2>/dev/null || true; '
            "rm -f /tmp/harbor-hf-inference-bridge.pid; fi"
        ),
    )

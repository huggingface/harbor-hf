"""Credential-isolating bridge for authenticated Hugging Face Job ingress."""

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
_LOCAL_API_KEY = "harbor-local-ingress-bridge"


def _run_hf_jobs_ingress_bridge() -> None:
    """Run as root inside the sandbox and inject the private ingress token."""
    import http.client
    import json
    import os
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from typing import override
    from urllib.parse import urlsplit

    upstream = urlsplit(os.environ["HARBOR_HF_INGRESS_UPSTREAM"])
    upstream_host = upstream.hostname
    if upstream_host is None:
        raise RuntimeError("HF Jobs ingress upstream host is missing")
    token = os.environ["HARBOR_HF_INGRESS_TOKEN"]
    port = int(os.environ["HARBOR_HF_INGRESS_LOCAL_PORT"])
    allowed_paths = {os.environ["HARBOR_HF_INGRESS_ALLOWED_PATH"]}
    base_path = upstream.path.rstrip("/")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:
            if self.path not in allowed_paths:
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self.send_error(400)
                return
            if length < 0 or length > 64 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            connection = http.client.HTTPSConnection(upstream_host, 443, timeout=1800)
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": self.headers.get("Content-Type", "application/json"),
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
                while chunk := response.read(64 * 1024):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (OSError, http.client.HTTPException):
                if not self.wfile.closed:
                    payload = json.dumps(
                        {"error": "ingress bridge transport failed"}
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

        @override
        def log_message(self, format: str, *args: object) -> None:
            del format, args

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def _bridge_command() -> str:
    body = inspect.getsource(_run_hf_jobs_ingress_bridge)
    script = body + "\n_run_hf_jobs_ingress_bridge()\n"
    return (
        "set -euo pipefail; "
        "if [ -f /tmp/harbor-hf-ingress-bridge.pid ]; then "
        "old_pid=$(cat /tmp/harbor-hf-ingress-bridge.pid); "
        'kill "$old_pid" 2>/dev/null || true; '
        "rm -f /tmp/harbor-hf-ingress-bridge.pid; fi; "
        "rm -f /tmp/harbor-hf-ingress-bridge.ready; "
        f"nohup python3 -c {shlex.quote(script)} "
        ">/tmp/harbor-hf-ingress-bridge.log 2>&1 & "
        "pid=$!; printf '%s\\n' \"$pid\" "
        ">/tmp/harbor-hf-ingress-bridge.pid; "
        "chmod 0444 /tmp/harbor-hf-ingress-bridge.pid; "
        "python3 - <<'PY'\n"
        "import os, socket, time\n"
        "port = int(os.environ['HARBOR_HF_INGRESS_LOCAL_PORT'])\n"
        "deadline = time.monotonic() + 10\n"
        "while True:\n"
        "    try:\n"
        "        with socket.create_connection(('127.0.0.1', port), timeout=0.25):\n"
        "            break\n"
        "    except OSError:\n"
        "        if time.monotonic() >= deadline:\n"
        "            raise SystemExit('HF Jobs ingress bridge did not become ready')\n"
        "        time.sleep(0.1)\n"
        "PY\n"
    )


def is_hf_jobs_ingress_url(value: str) -> bool:
    """Return whether *value* is a safe authenticated HF Jobs ingress URL."""
    parsed = urlsplit(value)
    return (
        parsed.scheme == "https"
        and parsed.hostname is not None
        and _HF_JOBS_HOST.fullmatch(parsed.hostname) is not None
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
    )


async def prepare_hf_jobs_ingress_bridge(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
    env: dict[str, str],
    *,
    base_url_key: str,
    api_key_key: str,
    ingress_token: str | None,
    api: Literal["chat-completions", "responses"],
    local_port: int = 18080,
) -> bool:
    """Replace an authenticated HF Job URL with a root-owned loopback bridge.

    Returns ``True`` when a bridge was installed. The private ingress token is
    delivered only to the root-owned process; the agent receives a loopback URL
    and an inert placeholder key.
    """
    base_url = env.get(base_url_key, "")
    if not is_hf_jobs_ingress_url(base_url):
        return False
    if not ingress_token:
        raise RuntimeError("HF Jobs ingress bridging requires an ingress token")
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
            "HARBOR_HF_INGRESS_UPSTREAM": upstream,
            "HARBOR_HF_INGRESS_TOKEN": ingress_token,
            "HARBOR_HF_INGRESS_LOCAL_PORT": str(local_port),
            "HARBOR_HF_INGRESS_ALLOWED_PATH": allowed_path,
        },
    )
    env[base_url_key] = f"http://127.0.0.1:{local_port}/v1"
    env[api_key_key] = _LOCAL_API_KEY
    try:
        await verify_hf_jobs_ingress_isolation(agent, environment)
    except BaseException:
        with suppress(Exception):
            await stop_hf_jobs_ingress_bridge(agent, environment)
        raise
    return True


async def verify_hf_jobs_ingress_isolation(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
) -> None:
    """Prove that the agent user cannot inspect the bridge credential state."""
    await agent.exec_as_agent(
        environment,
        command=(
            "set -euo pipefail; "
            "pid=$(cat /tmp/harbor-hf-ingress-bridge.pid); "
            "agent_uid=$(id -u); bridge_uid=$(stat -c %u /proc/$pid); "
            'test "$agent_uid" != "$bridge_uid"; '
            "if cat /proc/$pid/environ >/dev/null 2>&1; then exit 1; fi; "
            'printf \'{"agent_uid":%s,"bridge_uid":%s,'
            '"bridge_environment_readable":false}\\n\' '
            '"$agent_uid" "$bridge_uid" '
            ">/logs/agent/hf-jobs-ingress-isolation.json"
        ),
    )


async def stop_hf_jobs_ingress_bridge(
    agent: BaseInstalledAgent,
    environment: BaseEnvironment,
) -> None:
    """Stop the trial-local bridge and remove its process handle."""
    await agent.exec_as_root(
        environment,
        command=(
            "set -euo pipefail; "
            "if [ -f /tmp/harbor-hf-ingress-bridge.pid ]; then "
            "pid=$(cat /tmp/harbor-hf-ingress-bridge.pid); "
            'kill "$pid" 2>/dev/null || true; '
            "rm -f /tmp/harbor-hf-ingress-bridge.pid; fi"
        ),
    )

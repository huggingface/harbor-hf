"""Start the root-owned inference bridge before a Sandbox accepts commands."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from harbor_hf_agents.support.hf_inference_bridge import _bridge_command

_LOCAL_API_KEY = "harbor-local-inference-bridge"
_LOCAL_PORT = 18080
_ROUTE_PATHS = {
    "chat-completions": "/v1/chat/completions",
    "responses": "/v1/responses",
}


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required Sandbox bridge setting {name} is missing")
    return value


def main() -> None:
    """Start the bridge and publish only its non-secret loopback settings."""
    api = _required("HARBOR_HF_INFERENCE_API")
    try:
        allowed_path = _ROUTE_PATHS[api]
    except KeyError as error:
        raise RuntimeError("Sandbox bridge API is invalid") from error
    inference_token = _required("HF_INFERENCE_TOKEN")
    env = {
        **os.environ,
        "HARBOR_HF_INFERENCE_TOKEN": inference_token,
        "HARBOR_HF_INFERENCE_LOCAL_PORT": str(_LOCAL_PORT),
        "HARBOR_HF_INFERENCE_ALLOWED_PATH": allowed_path,
    }
    subprocess.run(
        ["/bin/bash", "-lc", _bridge_command()],
        check=True,
        env=env,
    )
    route = {
        "schema_version": "v1",
        "api": api,
        "base_url": f"http://127.0.0.1:{_LOCAL_PORT}/v1",
        "api_key": _LOCAL_API_KEY,
        "model": _required("HARBOR_HF_INFERENCE_ALLOWED_MODEL"),
    }
    path = Path("/run/harbor-hf-inference.json")
    path.write_text(json.dumps(route, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o644)


if __name__ == "__main__":
    main()

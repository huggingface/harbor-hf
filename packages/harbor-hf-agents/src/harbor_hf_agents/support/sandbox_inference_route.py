"""Load the non-secret inference route written by the Sandbox root bridge."""

from __future__ import annotations

import json

from harbor.environments.base import BaseEnvironment

from harbor_hf_agents.support.hf_inference_bridge import (
    verify_hf_inference_isolation,
)
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent


async def use_sandbox_inference_route(
    agent: IsolatedProviderAgent,
    environment: BaseEnvironment,
    env: dict[str, str],
    *,
    base_url_key: str,
    api_key_key: str,
    api: str,
    allowed_model: str,
) -> bool:
    """Use a locked loopback route when the Sandbox root bridge provides one."""
    result = await agent.exec_as_root(
        environment,
        command=(
            "if [ -f /run/harbor-hf-inference.json ]; then "
            "cat /run/harbor-hf-inference.json; fi"
        ),
    )
    text = (result.stdout or "").strip()
    if not text:
        return False
    value = json.loads(text)
    if set(value) != {"schema_version", "api", "base_url", "api_key", "model"}:
        raise RuntimeError("Sandbox inference route has unknown or missing fields")
    if (
        value["schema_version"] != "v1"
        or value["api"] != api
        or value["base_url"] != "http://127.0.0.1:18080/v1"
        or value["api_key"] != "harbor-local-inference-bridge"
        or value["model"] != allowed_model
    ):
        raise RuntimeError("Sandbox inference route does not match the locked model")
    env[base_url_key] = value["base_url"]
    env[api_key_key] = value["api_key"]
    await verify_hf_inference_isolation(agent, environment)
    return True

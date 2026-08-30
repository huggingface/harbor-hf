"""Load the non-secret inference route written by the Job root bridge."""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import TypeVar, cast

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.support.control_job_environment import ControlJobEnvironment
from harbor_hf_agents.support.hf_inference_bridge import (
    _job_bridge_pid,
    hf_inference_bridge_is_active,
    mark_hf_inference_bridge_active,
    stop_hf_inference_bridge,
    verify_hf_inference_isolation,
)
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent

_AgentT = TypeVar("_AgentT")
_RunMethod = Callable[[_AgentT, str, BaseEnvironment, AgentContext], Awaitable[None]]
_JOB_ROUTE_PATH = Path("/run/harbor-hf-inference.json")
JOB_INFERENCE_MAX_OUTPUT_TOKENS_ENV = "JOB_INFERENCE_MAX_OUTPUT_TOKENS"


@dataclass(frozen=True)
class JobInferenceRoute:
    """Validated non-secret route for the root-owned Job inference bridge."""

    base_url: str
    api_key: str
    max_output_tokens: int


def with_job_inference_bridge_cleanup(method: _RunMethod) -> _RunMethod:
    """Stop any root bridge before Harbor advances to verifier execution."""

    @wraps(method)
    async def wrapped(
        agent: _AgentT,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        try:
            await method(agent, instruction, environment, context)
        finally:
            try:
                if hf_inference_bridge_is_active(agent):
                    await stop_hf_inference_bridge(agent, environment)
            finally:
                if isinstance(environment, ControlJobEnvironment):
                    await environment.quiesce()

    return cast(_RunMethod, wrapped)


def _load_job_route() -> dict[str, object] | None:
    path = _JOB_ROUTE_PATH
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if (
        os.geteuid() != 0
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o644
        or metadata.st_size > 4096
    ):
        raise RuntimeError("Job inference route is not a bounded root-owned file")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, encoding="utf-8", closefd=False) as handle:
            value = json.load(handle)
    finally:
        os.close(descriptor)
    if not isinstance(value, dict):
        raise RuntimeError("Job inference route is invalid")
    return cast(dict[str, object], value)


def load_job_inference_route(
    *,
    api: str,
    allowed_model: str,
) -> JobInferenceRoute | None:
    """Load and validate the locked loopback route for trusted host code."""
    value = _load_job_route()
    if value is None:
        return None
    if set(value) != {
        "schema_version",
        "api",
        "base_url",
        "api_key",
        "model",
        "max_output_tokens",
    }:
        raise RuntimeError("Job inference route has unknown or missing fields")
    base_url = value["base_url"]
    api_key = value["api_key"]
    max_output_tokens = value["max_output_tokens"]
    if (
        value["schema_version"] != "v1"
        or value["api"] != api
        or not isinstance(base_url, str)
        or not isinstance(api_key, str)
        or base_url != "http://127.0.0.1:18080/v1"
        or api_key != "harbor-local-inference-bridge"
        or value["model"] != allowed_model
        or isinstance(max_output_tokens, bool)
        or not isinstance(max_output_tokens, int)
        or max_output_tokens <= 0
    ):
        raise RuntimeError("Job inference route does not match the locked execution")
    return JobInferenceRoute(
        base_url=base_url,
        api_key=api_key,
        max_output_tokens=max_output_tokens,
    )


async def use_job_inference_route(
    agent: IsolatedProviderAgent,
    environment: BaseEnvironment,
    env: dict[str, str],
    *,
    base_url_key: str,
    api_key_key: str,
    api: str,
    allowed_model: str,
) -> bool:
    """Use a locked loopback route when the Job root bridge provides one."""
    route = load_job_inference_route(api=api, allowed_model=allowed_model)
    if route is None:
        return False
    bridge_pid = _job_bridge_pid()
    env[base_url_key] = route.base_url
    env[api_key_key] = route.api_key
    env[JOB_INFERENCE_MAX_OUTPUT_TOKENS_ENV] = str(route.max_output_tokens)
    mark_hf_inference_bridge_active(agent, kind="job")
    await verify_hf_inference_isolation(
        agent,
        environment,
        bridge_pid=bridge_pid,
    )
    return True

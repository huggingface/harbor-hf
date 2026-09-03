"""Declarative provider-backed custom agent definitions."""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import JsonValue

from harbor_hf.models import AgentProfile
from harbor_hf.provider_models import ProviderTarget

ProviderApi = Literal["chat-completions", "responses"]


@dataclass(frozen=True)
class ProviderAgentDefinition:
    name: str
    import_path: str
    api: ProviderApi
    required_parameters: frozenset[str]
    allowed_parameters: frozenset[str]
    revision_kind: Literal["package", "git"]
    trajectory_schema: Literal["ATIF-v1.7"] = "ATIF-v1.7"
    session_required: bool = True


_OPENCLAW_PARAMETERS = frozenset(
    {
        "failover_retries",
        "openclaw_agent_id",
        "openclaw_config",
        "openclaw_node_version",
        "session_to_trajectory",
        "thinking",
        "timeout",
    }
)

PROVIDER_AGENTS: dict[str, ProviderAgentDefinition] = {
    "hermes": ProviderAgentDefinition(
        name="hermes",
        import_path="harbor_hf_agents.hermes.agent:HermesAgent",
        api="chat-completions",
        required_parameters=frozenset(),
        allowed_parameters=frozenset(),
        revision_kind="git",
    ),
    "openclaw": ProviderAgentDefinition(
        name="openclaw",
        import_path="harbor_hf_agents.openclaw.agent:OpenClawAgent",
        api="chat-completions",
        required_parameters=frozenset({"openclaw_config"}),
        allowed_parameters=_OPENCLAW_PARAMETERS,
        revision_kind="package",
    ),
    "openclaw-codex": ProviderAgentDefinition(
        name="openclaw-codex",
        import_path=("harbor_hf_agents.openclaw_codex.agent:OpenClawCodexAgent"),
        api="responses",
        required_parameters=frozenset(
            {
                "codex_plugin_version",
                "codex_request_timeout_ms",
                "model_context_window",
                "model_max_tokens",
                "openclaw_node_version",
            }
        ),
        allowed_parameters=_OPENCLAW_PARAMETERS
        | {
            "codex_plugin_version",
            "codex_request_timeout_ms",
            "model_context_window",
            "model_max_tokens",
        },
        revision_kind="package",
    ),
    "pi": ProviderAgentDefinition(
        name="pi",
        import_path="harbor_hf_agents.pi.agent:PiAgent",
        api="chat-completions",
        required_parameters=frozenset(),
        allowed_parameters=frozenset({"model_runtime", "models_json", "thinking"}),
        revision_kind="package",
        session_required=False,
    ),
}


def provider_agent_definition(name: str) -> ProviderAgentDefinition:
    try:
        return PROVIDER_AGENTS[name]
    except KeyError as error:
        supported = ", ".join(sorted(PROVIDER_AGENTS))
        raise ValueError(
            f"Inference Provider targets require one of: {supported}"
        ) from error


def validate_provider_agent(
    agent: AgentProfile,
    target: ProviderTarget,
) -> ProviderAgentDefinition:
    definition = provider_agent_definition(agent.name)
    if agent.import_path != definition.import_path:
        raise ValueError(
            f"provider agent {agent.name} requires import_path {definition.import_path}"
        )
    if target.api != definition.api:
        raise ValueError(
            f"provider agent {agent.name} requires the {definition.api} API"
        )
    if agent.revision_kind != definition.revision_kind:
        raise ValueError(
            f"provider agent {agent.name} requires revision_kind "
            f"{definition.revision_kind}"
        )
    keys = set(agent.parameters)
    missing = definition.required_parameters - keys
    if missing:
        raise ValueError(
            f"provider agent {agent.name} is missing parameters: "
            + ", ".join(sorted(missing))
        )
    unexpected = keys - definition.allowed_parameters
    if unexpected:
        raise ValueError(
            f"provider agent {agent.name} has unsupported parameters: "
            + ", ".join(sorted(unexpected))
        )
    if agent.name == "pi" and len(keys & {"model_runtime", "models_json"}) != 1:
        raise ValueError(
            "provider agent pi requires exactly one model_runtime or models_json"
        )
    return definition


def effective_provider_agent_parameters(
    agent: AgentProfile,
    target: ProviderTarget,
) -> dict[str, JsonValue]:
    validate_provider_agent(agent, target)
    parameters = deepcopy(agent.parameters)
    parameters["provider_runtime"] = {
        "api": target.api,
        "timeout_seconds": target.timeout_seconds,
        "max_attempts": target.limits.max_attempts,
    }
    return parameters


def validate_provider_agent_evidence(
    root: Path,
    *,
    definition: ProviderAgentDefinition,
    expected_agent_name: str,
    expected_agent_version: str,
    expected_model_name: str,
) -> None:
    trajectory_path = root / "agent" / "trajectory.json"
    try:
        trajectory = json.loads(trajectory_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise _worker_error(
            "provider agent trajectory is missing or malformed"
        ) from error
    if not isinstance(trajectory, dict):
        raise _worker_error("provider agent trajectory must be an object")
    if trajectory.get("schema_version") != definition.trajectory_schema:
        raise _worker_error("provider agent trajectory schema does not match the lock")
    observed_agent = trajectory.get("agent")
    if not isinstance(observed_agent, dict):
        raise _worker_error("provider agent trajectory identity is missing")
    expected_model = f"openai/{expected_model_name}"
    expected = {
        "name": expected_agent_name,
        "version": expected_agent_version,
        "model_name": expected_model,
    }
    if any(observed_agent.get(key) != value for key, value in expected.items()):
        raise _worker_error(
            "provider agent trajectory identity does not match the lock"
        )
    steps = trajectory.get("steps")
    if not isinstance(steps, list) or len(steps) < 2:
        raise _worker_error("provider agent trajectory is incomplete")


def _worker_error(message: str) -> RuntimeError:
    # Import lazily so the registry remains independent of harbor_adapter's
    # public re-export module, which imports the adapter and this registry.
    from harbor_hf.harbor_adapter.errors import WorkerError

    return WorkerError(message)

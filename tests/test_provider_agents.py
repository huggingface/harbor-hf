from __future__ import annotations

import json
from pathlib import Path

import pytest

from harbor_hf.harbor_adapter.errors import WorkerError
from harbor_hf.models import AgentProfile
from harbor_hf.provider_agents import (
    PROVIDER_AGENTS,
    effective_provider_agent_parameters,
    provider_agent_definition,
    validate_provider_agent,
    validate_provider_agent_evidence,
)
from harbor_hf.provider_models import ProviderLimits, ProviderTarget


def _agent(name: str = "openclaw") -> AgentProfile:
    definition = provider_agent_definition(name)
    parameters: dict[str, object]
    revision: str
    if name == "hermes":
        parameters = {}
        revision = "a" * 40
    elif name == "openclaw":
        parameters = {"openclaw_config": {}}
        revision = "2026.7.1-2"
    elif name == "openclaw-codex":
        parameters = {
            "codex_plugin_version": "2026.7.1-1",
            "codex_request_timeout_ms": 600000,
            "model_context_window": 131072,
            "model_max_tokens": 32768,
            "openclaw_node_version": "24.15.0",
        }
        revision = "2026.7.1-2"
    else:
        parameters = {
            "models_json": {
                "providers": {
                    "openai": {
                        "api": "openai-completions",
                        "baseUrl": "$OPENAI_BASE_URL",
                        "models": [{"id": "example/model:together"}],
                    }
                }
            }
        }
        revision = "0.82.1"
    return AgentProfile.model_validate(
        {
            "id": name,
            "name": name,
            "import_path": definition.import_path,
            "revision": revision,
            "revision_kind": definition.revision_kind,
            "parameters": parameters,
        }
    )


def _target(api: str = "chat-completions") -> ProviderTarget:
    return ProviderTarget.model_validate(
        {
            "id": "provider",
            "api": api,
            "model": "example/model",
            "timeout_seconds": 17.25,
            "limits": {"max_attempts": 3},
        }
    )


def test_registry_defines_each_provider_agent_once() -> None:
    assert set(PROVIDER_AGENTS) == {"hermes", "openclaw", "openclaw-codex", "pi"}
    assert len({definition.import_path for definition in PROVIDER_AGENTS.values()}) == 4
    assert PROVIDER_AGENTS["openclaw-codex"].api == "responses"
    assert PROVIDER_AGENTS["pi"].session_required is False


@pytest.mark.parametrize(
    ("name", "api"),
    [
        ("hermes", "chat-completions"),
        ("openclaw", "chat-completions"),
        ("openclaw-codex", "responses"),
        ("pi", "chat-completions"),
    ],
)
def test_registry_accepts_only_the_locked_agent_contract(name: str, api: str) -> None:
    agent = _agent(name)
    definition = validate_provider_agent(agent, _target(api))
    assert definition is PROVIDER_AGENTS[name]

    with pytest.raises(ValueError, match="requires import_path"):
        validate_provider_agent(
            agent.model_copy(update={"import_path": None}), _target(api)
        )
    wrong_api = "responses" if api == "chat-completions" else "chat-completions"
    with pytest.raises(ValueError, match=f"requires the {api} API"):
        validate_provider_agent(agent, _target(wrong_api))


def test_effective_parameters_add_only_the_generic_runtime_contract() -> None:
    agent = _agent("openclaw")
    target = _target()

    effective = effective_provider_agent_parameters(agent, target)

    assert effective == {
        "openclaw_config": {},
        "provider_runtime": {
            "api": "chat-completions",
            "timeout_seconds": 17.25,
            "max_attempts": 3,
        },
    }
    assert "provider_runtime" not in agent.parameters


def test_registry_rejects_missing_and_unknown_agent_parameters() -> None:
    with pytest.raises(ValueError, match="missing parameters: openclaw_config"):
        validate_provider_agent(
            _agent("openclaw").model_copy(update={"parameters": {}}), _target()
        )
    with pytest.raises(ValueError, match="unsupported parameters: invented"):
        validate_provider_agent(
            _agent("openclaw").model_copy(
                update={"parameters": {"openclaw_config": {}, "invented": True}}
            ),
            _target(),
        )


def _write_evidence(root: Path) -> None:
    agent_root = root / "agent"
    agent_root.mkdir(parents=True)
    (agent_root / "hf-inference-isolation.json").write_text(
        json.dumps(
            {
                "agent_uid": 1000,
                "bridge_uid": 0,
                "bridge_environment_readable": False,
            }
        ),
        encoding="utf-8",
    )
    (agent_root / "trajectory.json").write_text(
        json.dumps(
            {
                "schema_version": "ATIF-v1.7",
                "agent": {
                    "name": "openclaw",
                    "version": "2026.7.1-2",
                    "model_name": "openai/example/model:together",
                },
                "steps": [{"step_id": 1}, {"step_id": 2}],
            }
        ),
        encoding="utf-8",
    )


def test_provider_evidence_requires_locked_identity_and_uid_isolation(
    tmp_path: Path,
) -> None:
    _write_evidence(tmp_path)
    definition = provider_agent_definition("openclaw")

    validate_provider_agent_evidence(
        tmp_path,
        definition=definition,
        expected_agent_name="openclaw",
        expected_agent_version="2026.7.1-2",
        expected_model_name="example/model:together",
    )

    isolation = tmp_path / "agent" / "hf-inference-isolation.json"
    isolation.write_text(
        json.dumps(
            {
                "agent_uid": 0,
                "bridge_uid": 0,
                "bridge_environment_readable": False,
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(WorkerError, match="isolation evidence is invalid"):
        validate_provider_agent_evidence(
            tmp_path,
            definition=definition,
            expected_agent_name="openclaw",
            expected_agent_version="2026.7.1-2",
            expected_model_name="example/model:together",
        )


def test_provider_limits_used_by_test_target_are_valid() -> None:
    assert _target().limits == ProviderLimits(max_attempts=3)

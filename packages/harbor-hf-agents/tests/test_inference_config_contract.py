"""Pinned public config integration and static delivery contract; no agent/tasks run."""

import ast
import json
from importlib.metadata import distribution

from harbor.models.job.config import JobConfig

PIN = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e"


def test_public_config_preserves_native_model_and_unresolved_reference(monkeypatch):
    monkeypatch.delenv("INFERENCE_API_KEY_EXAMPLE", raising=False)
    model = (
        "native:model?routeApi=responses&baseUrl=https://synthetic.example.invalid/v1"
    )
    config = JobConfig.model_validate(
        {
            "agents": [
                {
                    "import_path": "synthetic.compatible:Agent",
                    "model_name": model,
                    "env": {"OPENAI_API_KEY": "${INFERENCE_API_KEY_EXAMPLE}"},
                }
            ]
        }
    )
    saved = config.model_dump_json()
    restored = JobConfig.model_validate_json(saved)
    assert restored.agents[0].model_name == model
    assert restored.agents[0].env == {"OPENAI_API_KEY": "${INFERENCE_API_KEY_EXAMPLE}"}
    assert "INFERENCE_SECRET_" not in saved


def test_pinned_static_harbor_delivery_contract():
    # Read source without importing factory, resolver, Trial or constructing an agent.
    installed = distribution("harbor")
    provenance = json.loads(installed.read_text("direct_url.json") or "{}")
    assert provenance["vcs_info"]["commit_id"] == PIN
    root = installed.locate_file("harbor")
    factory = ast.parse((root / "agents/factory.py").read_text())
    method = next(
        node
        for node in ast.walk(factory)
        if isinstance(node, ast.FunctionDef) and node.name == "create_agent_from_config"
    )
    source = ast.unparse(method)
    assert "extra_env = resolve_env_vars(config.env)" in source
    assert "extra_env=extra_env" in source
    assert "model_name=config.model_name" in source
    base = (root / "agents/base.py").read_text()
    assert "def extra_env(self) -> dict[str, str]:" in base
    assert "return dict(self._extra_env)" in base
    trial = (root / "trial/trial.py").read_text()
    assert "scoped_exec_env(self.agent.extra_env)" in trial
    assert "exec_env = self.agent.extra_env" in trial
    assert "scoped_exec_env(exec_env)" in trial
    # Static inspection is not proof of remote delivery, isolation or redaction.

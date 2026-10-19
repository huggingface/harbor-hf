"""Pinned public config integration and static delivery contract; no agent/tasks run."""

import ast
import json
import tomllib
from importlib.metadata import distribution
from pathlib import Path

from harbor.models.job.config import JobConfig

PIN = "11a0fe2d3305e144a5e8af625d50a7394f293f75"


def test_worker_dependency_and_revision_guards_agree():
    from harbor_hf_agents import launch
    from harbor_hf_agents.scrub_before_upload import SCRUB_REVISION

    project = Path(__file__).parents[1] / "pyproject.toml"
    dependencies = tomllib.loads(project.read_text())["project"]["dependencies"]
    [harbor] = [value for value in dependencies if value.startswith("harbor[")]
    assert harbor.endswith("@" + PIN)
    assert launch.REVISION == SCRUB_REVISION == PIN
    root = Path(__file__).parents[3]
    control = root / "apps/control-api/src/harbor-revision.ts"
    assert control.read_text().strip() == f'export const HARBOR_REVISION = "{PIN}";'
    launch.check_revision()


def test_exported_job_schema_matches_the_installed_harbor():
    root = Path(__file__).parents[3]
    schema = root / "packages/contracts/schemas/harbor-job-config-v1.schema.json"
    saved = json.loads(schema.read_text())
    native = JobConfig.model_json_schema()
    # Only document identity belongs to this repository; fields belong to Harbor.
    for key in ("$id", "$schema", "title"):
        saved.pop(key, None)
        native.pop(key, None)
    assert saved == native


def test_provider_library_matches_the_declared_runtime_pin():
    project = Path(__file__).parents[1] / "pyproject.toml"
    dependencies = tomllib.loads(project.read_text())["project"]["dependencies"]
    [provider] = [value for value in dependencies if value.startswith("litellm==")]
    assert distribution("litellm").version == provider.split("==", 1)[1]


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

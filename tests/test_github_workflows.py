import re
from pathlib import Path
from typing import cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"


def _record(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    return cast(dict[str, object], value)


def _workflow(name: str) -> dict[str, object]:
    value: object = yaml.load((WORKFLOWS / name).read_text(), Loader=yaml.BaseLoader)
    return _record(value)


def test_mutation_testing_paths_are_absent() -> None:
    root = WORKFLOWS.parents[1]

    assert not (WORKFLOWS / "mutation.yml").exists()
    assert not (root / "scripts" / "check_mutation.py").exists()
    assert "mutmut" not in (root / "pyproject.toml").read_text()
    assert (
        "mutmut"
        not in (root / "packages" / "harbor-hf-agents" / "pyproject.toml").read_text()
    )
    assert "mutmut" not in (root / "uv.lock").read_text()
    assert (
        "mutmut" not in (root / "packages" / "harbor-hf-agents" / "uv.lock").read_text()
    )
    slophammer = (root / "slophammer.yml").read_text()
    assert "\n  mutation:\n" not in slophammer
    for workflow in WORKFLOWS.glob("*.yml"):
        assert "check_mutation.py" not in workflow.read_text()


def test_superseded_profile_and_worker_paths_are_absent() -> None:
    root = WORKFLOWS.parents[1]
    obsolete_paths = (
        "profiles",
        "deploy/trial-worker",
        "apps/control-api/src/api-schemas.ts",
        "apps/control-api/src/local-harbor.ts",
        "apps/control-web/src/hints.ts",
        "apps/control-web/src/launch.ts",
        "packages/control-core/src/execution-contract.ts",
        "packages/control-core/src/run-configs.ts",
        "packages/harbor-hf-agents/src/harbor_hf_agents/support/direct_inference.py",
        "src/harbor_hf/harbor_adapter",
    )

    for relative in obsolete_paths:
        assert not (root / relative).exists(), f"obsolete path returned: {relative}"


def test_package_publication_has_no_mutation_preflight() -> None:
    workflow = _workflow("publish.yml")
    jobs = _record(workflow["jobs"])

    assert "mutation" not in jobs
    publish = _record(jobs["publish"])
    assert "needs" not in publish


def test_trial_worker_publication_pins_privileged_actions() -> None:
    workflow = _workflow("publish-trial-worker.yml")
    jobs = _record(workflow["jobs"])
    publish = _record(jobs["publish"])
    steps = publish["steps"]
    assert isinstance(steps, list)

    for step in steps:
        uses = _record(step).get("uses")
        if uses is not None:
            assert re.fullmatch(r"[^@]+@[0-9a-f]{40}", str(uses))

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


def test_mutation_workflow_is_manual_and_reusable() -> None:
    workflow = _workflow("mutation.yml")

    assert set(_record(workflow["on"])) == {"workflow_call", "workflow_dispatch"}
    assert "check_mutation.py" not in (WORKFLOWS / "ci.yml").read_text()


def test_package_publication_waits_for_mutation_tests() -> None:
    workflow = _workflow("publish.yml")
    jobs = _record(workflow["jobs"])

    assert _record(jobs["mutation"]) == {
        "name": "Mutation preflight",
        "uses": "./.github/workflows/mutation.yml",
    }
    publish = _record(jobs["publish"])
    assert publish["needs"] == "mutation"

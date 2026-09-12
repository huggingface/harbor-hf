"""Native result metadata names and lock task-ID names have separate authority."""

import copy
from pathlib import Path

import pytest
from harbor.models.job.config import JobConfig
from harbor.models.trial.config import TaskConfig
from test_replacements import ROOT, child

from harbor_hf_agents import replacements
from harbor_hf_agents.replacement_evidence import Evidence, native

pytest_plugins = ["test_replacements"]


@pytest.mark.parametrize("kind", ["git", "local", "package"])
def test_native_names_preserved_for_each_task_id(factory, kind):
    original, _ = factory()
    config = JobConfig.model_validate(original["config"])
    if kind == "local":
        config.tasks = [TaskConfig(path=Path("A"))] * 3
    elif kind == "package":
        config.tasks = [TaskConfig(name="example-org/A", ref="sha256:" + "d" * 64)] * 3
    original, plan = factory(config=config)
    before = copy.deepcopy(original)
    evidence = Evidence.parse(original)
    assert [native(t) for t in evidence.trials] == before["trials"]
    assert native(evidence.lock) == before["lock"]
    for trial, lock in zip(evidence.trials, plan.job_lock.trials, strict=True):
        assert lock.task.name == trial.task_id.get_name()
    assert original == before


@pytest.mark.asyncio
async def test_aggregate_preserves_metadata_names_and_exact_repeat_ids(factory):
    original, plan = factory(names=("A",) * 5)
    before = copy.deepcopy(original)
    replacement, _ = child(factory, original, [2], failures=[])
    response = await replacements.aggregate(
        {"original": original, "parts": [{"evidence": replacement, "parts": []}]},
        ROOT,
    )
    expected = original["trials"][:2] + original["trials"][3:] + replacement["trials"]
    assert response["result"]["trial_results"] == expected
    assert original == before
    assert all(t["task_name"] == expected[0]["task_name"] for t in expected)
    assert len({t["id"] for t in expected}) == len(plan.job_lock.trials) == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["id", "source", "lock-name", "lock-source"])
async def test_review_validates_unselected_native_identity(factory, corruption):
    original, _ = factory()
    # Select the first attempt, but corrupt a different source attempt.
    trial = original["trials"][2]
    if corruption == "id":
        trial["task_id"]["path"] = "foreign"
    elif corruption == "source":
        trial["source"] = "foreign"
    else:
        key = "name" if corruption == "lock-name" else "source"
        original["lock"]["trials"][2]["task"][key] = "foreign"
    original["result"].pop("trial_results")
    with pytest.raises(
        ValueError, match="identity mismatch|does not match native lock"
    ):
        await replacements.review(
            {"original": original, "trial_ids": [original["trials"][0]["id"]]},
            ROOT,
        )

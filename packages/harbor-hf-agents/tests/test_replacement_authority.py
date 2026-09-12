"""Trusted existing execution is authority, not a fresh direct-config request."""

import copy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from harbor.job_plan import JobPlan
from harbor.models.job.config import JobConfig
from harbor.models.trial.config import AgentConfig, TaskConfig
from replacement_compiler_fixture import WORKBENCH_AGENT
from test_replacements import NOW, ROOT, SHA, URL, child, run_id

from harbor_hf_agents import launch, replacements
from harbor_hf_agents.replacement_evidence import Evidence, native

pytest_plugins = ["test_replacements"]
PRIVATE = "https://huggingface.co/datasets/example-org/example-dataset.git"


def review_request(original, ancestors=()):
    return {
        "original": original,
        "original_ancestors": list(ancestors),
        "trial_ids": [t["id"] for t in original["trials"]],
        "run_id": run_id(9),
        "local_root": "/data",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "agent",
    [
        WORKBENCH_AGENT,
        {
            "import_path": "harbor_hf_agents.pi.agent:PiAgent",
            "kwargs": {"version": "0.84.4"},
        },
        {"name": "terminus-2", "kwargs": {}},
    ],
)
async def test_exact_original_native_components_not_catalog_readmitted(factory, agent):
    original, _ = factory()
    config = JobConfig.model_validate(original["config"])
    config.agents = [
        AgentConfig.model_validate(
            {
                **copy.deepcopy(agent),
                "model_name": "huggingface/example/model:provider",
                "env": {"OPENAI_API_KEY": "${HF_INFERENCE_TOKEN}"},
            }
        )
    ]
    original, _ = factory(config=config)
    response = await replacements.review(review_request(original), ROOT)
    assert response["effective_config"]["agents"] == original["config"]["agents"]
    replacement, _ = child(factory, original, [0, 1, 2])
    second = await replacements.review(review_request(replacement, [original]), ROOT)
    assert second["effective_config"]["agents"] == original["config"]["agents"]
    if agent == WORKBENCH_AGENT:
        with pytest.raises(ValueError, match="catalog"):
            launch.check_agents(config, launch.catalog(ROOT), [])


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [URL, PRIVATE])
async def test_dataset_ancestry_native_planning_a2_b1(factory, monkeypatch, url):
    original, _ = factory()
    config = JobConfig.model_validate(original["config"])
    for task in config.tasks:
        task.git_url = url
        task.source = "example-dataset"
    original, _ = factory(config=config)
    tasks = [TaskConfig.model_validate(t) for t in original["config"]["tasks"]]
    original["config"]["datasets"] = [{"repo": f"{url}@{SHA}", "path": "tasks"}]
    original["config"]["tasks"] = []
    original["record"]["harbor_job_config"] = copy.deepcopy(original["config"])
    # Mock only external registry metadata; native DatasetConfig compiles the
    # actual TaskConfigs and JobPlan owns both planning and metric resolution.
    client = SimpleNamespace(
        get_dataset_metadata=AsyncMock(
            return_value=SimpleNamespace(
                name="example-dataset",
                task_ids=[task.get_task_id() for task in tasks],
                files=[],
                metrics=[],
            )
        )
    )
    monkeypatch.setattr(launch.RegistryClientFactory, "create", lambda **_: client)
    metrics = AsyncMock(wraps=JobPlan.resolve_metrics)
    monkeypatch.setattr(JobPlan, "resolve_metrics", metrics)
    monkeypatch.setenv("HF_TOKEN", "synthetic-test-not-a-credential")
    monkeypatch.setattr(launch.shutil, "which", lambda _: "/usr/bin/git-lfs")
    replacement, _ = child(factory, original, [0, 1, 2])
    response = await replacements.review(review_request(replacement, [original]), ROOT)
    assert sorted(t["path"] for t in response["effective_config"]["tasks"]) == [
        "A",
        "A",
        "B",
    ]
    grandchild, _ = child(factory, replacement, [0, 1, 2], number=3)
    await replacements.review(review_request(grandchild, [replacement, original]), ROOT)
    result = await replacements.aggregate(
        {
            "original": replacement,
            "original_ancestors": [original],
            "parts": [{"evidence": grandchild, "parts": []}],
        },
        ROOT,
    )
    assert result["result"]["trial_results"] == grandchild["trials"]
    assert metrics.call_args.args[0] == Evidence.parse(original).config
    for operation, request in [
        (replacements.review, review_request(replacement)),
        (replacements.aggregate, {"original": replacement, "parts": []}),
    ]:
        with pytest.raises(ValueError, match="Missing replacement ancestor"):
            await operation(request, ROOT)


@pytest.mark.parametrize(
    "mutation", ["missing", "foreign", "unused", "duplicate", "cycle", "fingerprint"]
)
def test_ancestor_bundles_fail_closed(factory, mutation):
    original, _ = factory()
    replacement, _ = child(factory, original, [0])
    ancestors = [original]
    if mutation == "missing":
        ancestors = []
    elif mutation == "foreign":
        ancestors = [factory(number=8)[0]]
    elif mutation == "unused":
        ancestors.append(factory(number=8)[0])
    elif mutation == "duplicate":
        ancestors.append(original)
    elif mutation == "cycle":
        original["record"]["operator_selection"] = {"original_run_id": run_id(2)}
    else:
        replacement["record"]["operator_selection"]["source_fingerprint"] = "changed"
    with pytest.raises(ValueError):
        replacements.request_ancestry(Evidence.parse(replacement), ancestors)


def test_foreign_sdk_loader_rejected(factory):
    original, _ = factory()
    replacement, _ = child(factory, original, [0])
    foreign, _ = factory(number=8)
    with pytest.raises(ValueError, match="Foreign"):
        replacements.ancestry(
            Evidence.parse(replacement), lambda _: Evidence.parse(foreign)
        )


@pytest.mark.parametrize("field", ["agent", "model", "recipe"])
def test_changed_components_rejected_even_with_self_consistent_child(factory, field):
    original, _ = factory()
    config = JobConfig.model_validate(original["config"])
    config.agents = [
        AgentConfig.model_validate(
            {
                **copy.deepcopy(WORKBENCH_AGENT),
                "model_name": "huggingface/example/model:provider",
            }
        )
    ]
    original, _ = factory(config=config)
    replacement, _ = child(factory, original, [0])
    changed = JobConfig.model_validate(replacement["config"])
    if field == "agent":
        changed.agents[0].import_path = "harbor_hf_agents.pi.agent:PiAgent"
    elif field == "model":
        changed.agents[0].model_name = "huggingface/example/other:provider"
    else:
        changed.agents[0].kwargs["config"]["run"]["script"] = "changed"
    # Changing native config alone cannot override the immutable run record.
    forged = copy.deepcopy(original)
    forged["config"]["agents"] = native(changed)["agents"]
    with pytest.raises(ValueError, match="record configuration"):
        Evidence.parse(forged)
    forged, _ = factory(config=changed, number=2)
    forged["record"]["operator_selection"] = replacement["record"]["operator_selection"]
    with pytest.raises(ValueError, match="approved derivation"):
        replacements.request_ancestry(Evidence.parse(forged), [original])


@pytest.mark.asyncio
async def test_aggregate_uses_actual_job_times_not_selected_trial_or_clock(factory):
    original, _ = factory()
    original["result"]["started_at"] = (NOW - timedelta(hours=1)).isoformat()
    replacement, _ = child(factory, original, [0, 1, 2])
    replacement["result"]["finished_at"] = (NOW + timedelta(hours=5)).isoformat()
    grandchild, _ = child(factory, replacement, [0, 1, 2], number=3)
    grandchild["result"]["finished_at"] = (NOW + timedelta(hours=2)).isoformat()
    response = await replacements.aggregate(
        {
            "original": original,
            "parts": [
                {
                    "evidence": replacement,
                    "parts": [{"evidence": grandchild, "parts": []}],
                }
            ],
        },
        ROOT,
    )
    result = response["result"]
    assert result["started_at"] == native(Evidence.parse(original).result)["started_at"]
    assert (
        result["finished_at"]
        == native(Evidence.parse(replacement).result)["finished_at"]
    )
    assert result["updated_at"] == result["finished_at"]
    assert result["id"] == original["result"]["id"]
    assert result["trial_results"] == grandchild["trials"]


@pytest.mark.asyncio
async def test_inherited_native_factory_and_options_policy_still_applies(factory):
    original, _ = factory()
    config = JobConfig.model_validate(original["config"])
    config.agents[0].import_path = "harbor_hf_agents.missing:MissingAgent"
    original, _ = factory(config=config)
    with pytest.raises((ImportError, ValueError)):
        await replacements.review(review_request(original), ROOT)
    config.agents = [AgentConfig(name="terminus-2", kwargs={"unknown_option": True})]
    original, _ = factory(config=config)
    with pytest.raises(ValueError):
        await replacements.review(review_request(original), ROOT)


def test_typescript_metric_fixture_is_real_native_mean():
    import json

    from harbor.metrics.mean import Mean

    fixture = ROOT.parent / "packages/control-core/test/fixtures/native-mean.json"
    assert json.loads(fixture.read_text()) == {
        "single": Mean().compute([{"reward": 1}, None]),
        "multi_reward": Mean().compute([{"mean": 0.9, "accuracy": 0.1}]),
    }

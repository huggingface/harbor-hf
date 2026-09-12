"""Offline replacement contracts against the actual pinned native planner."""

import copy
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from harbor.job_plan import JobPlan
from harbor.metrics.mean import Mean
from harbor.models.job.config import JobConfig
from harbor.models.task.task import Task
from harbor.models.trial.config import TaskConfig
from harbor.models.trial.result import AgentInfo, ExceptionInfo, TrialResult
from harbor.models.verifier.result import VerifierResult
from harbor.tasks.client import TaskDownloadResult

from harbor_hf_agents import launch, replacements
from harbor_hf_agents.replacement_evidence import Evidence, derive, native

ROOT = Path(__file__).resolve().parents[3] / "presets"
SHA = "a" * 40
URL = "https://github.com/example-org/example-task.git"
NOW = datetime(2026, 1, 1, tzinfo=UTC)


def run_id(number):
    return f"run-{number:024x}"


@pytest.fixture(params=[True, False], ids=["metadata-name", "fallback-name"])
def factory(tmp_path, monkeypatch, request):
    downloads = {}
    for name in ("A", "B"):
        path = tmp_path / name
        path.mkdir()
        (path / "tests").mkdir()
        (path / "tests/test.sh").write_text("#!/bin/sh\nexit 0\n")
        (path / "instruction.md").write_text("Do the task.")
        (path / "task.toml").write_text(
            (f'[task]\nname="example-org/{name}"\n' if request.param else "")
            + '[environment]\ndocker_image="example/task:fixed"\n'
        )
        task = TaskConfig(path=Path(name), git_url=URL, git_commit_id=SHA)
        downloads[task.get_task_id()] = TaskDownloadResult(
            path=path, download_time_sec=0, cached=True, resolved_git_commit_id=SHA
        )
        private_task = task.model_copy(
            update={
                "git_url": "https://huggingface.co/datasets/example-org/example-dataset.git"
            }
        )
        downloads[private_task.get_task_id()] = downloads[task.get_task_id()]
        for other in (
            TaskConfig(path=Path(name)),
            TaskConfig(name=f"example-org/{name}", ref="sha256:" + "d" * 64),
        ):
            downloads[other.get_task_id()] = TaskDownloadResult(
                path=path, download_time_sec=0, cached=True
            )
    monkeypatch.setattr(JobPlan, "cache_tasks", AsyncMock(return_value=downloads))

    def make(names=("A", "A", "B"), number=1, config=None, failures=None):
        if config is None:
            config = JobConfig(
                job_name="job",
                jobs_dir=Path("/data/runs") / run_id(number),
                tasks=[
                    TaskConfig(path=Path(n), git_url=URL, git_commit_id=SHA)
                    for n in names
                ],
                agents=[
                    {
                        "import_path": "harbor_hf_agents.pi.agent:PiAgent",
                        "model_name": "huggingface/example/model:provider",
                        "kwargs": {"version": "0.84.4"},
                    }
                ],
                environment={
                    "import_path": (
                        "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment"
                    ),
                    "kwargs": {"flavor": "cpu-basic", "run_label": run_id(number)},
                },
            )
        plan = JobPlan.from_resolved(
            config,
            task_configs=config.tasks,
            metrics={"adhoc": [Mean()]},
            task_download_results=downloads,
        )
        trials = []
        for i, trial_config in enumerate(plan.trial_configs):
            trial_config.trial_name = f"trial-{i}"
            task = trial_config.task
            trials.append(
                TrialResult(
                    task_name=Task(downloads[task.get_task_id()].path).name,
                    trial_name=trial_config.trial_name,
                    trial_uri=f"file://{trial_config.trials_dir}/{trial_config.trial_name}",
                    task_id=task.get_task_id(),
                    source=task.source,
                    task_checksum=Task(downloads[task.get_task_id()].path).checksum,
                    config=trial_config,
                    agent_info=AgentInfo(name="pi", version="0.84.4"),
                    started_at=NOW,
                    finished_at=NOW,
                    verifier_environment_mode=plan.job_lock.trials[
                        i
                    ].verifier.environment_mode,
                    exception_info=ExceptionInfo(
                        exception_type="RuntimeError",
                        exception_message="infrastructure",
                        exception_traceback="",
                        occurred_at=NOW,
                    )
                    if failures is None or i in failures
                    else None,
                    verifier_result=VerifierResult(rewards={"reward": float(i % 2)}),
                )
            )
        result = plan.aggregate(trials, started_at=NOW, finished_at=NOW, updated_at=NOW)
        bundle = {
            "record": {
                "schema_version": "v1",
                "run_id": run_id(number),
                "harbor_revision": launch.REVISION,
                "harbor_job_config": native(config),
            },
            "config": native(config),
            "lock": native(plan.job_lock),
            "result": native(result),
            "trials": [native(t) for t in trials],
        }
        return bundle, plan

    return make


def child(factory, original, indices, number=2, failures=None):
    source = Evidence.parse(original)
    selected = source.select([original["trials"][i]["id"] for i in indices])
    config = derive(source, selected, run_id(number), Path("/data"))
    bundle, plan = factory(config=config, number=number, failures=failures)
    bundle["record"]["operator_selection"] = {
        "original_run_id": source.run_id,
        "trial_ids": [str(t.id) for t in selected],
        "source_fingerprint": source.fingerprint(selected),
    }
    return bundle, plan


@pytest.mark.asyncio
async def test_review_preserves_uneven_multiplicity_and_recipe(factory):
    original, _ = factory()
    response = await replacements.review(
        {
            "original": original,
            "trial_ids": [t["id"] for t in original["trials"]],
            "run_id": run_id(2),
            "local_root": "/data",
            "approved_sources": [],
        },
        ROOT,
    )
    assert set(response) == {
        "harbor_revision",
        "tasks",
        "agents",
        "trials",
        "warnings",
        "not_performed",
        "effective_config",
        "fingerprint",
    }
    config = response["effective_config"]
    assert Counter(t["path"] for t in config["tasks"]) == {"A": 2, "B": 1}
    assert config["agents"] == original["config"]["agents"]
    assert config["datasets"] == [] and config["n_attempts"] == 1
    assert response["trials"] == 3
    other = await replacements.review(
        {
            "original": original,
            "trial_ids": list(reversed([t["id"] for t in original["trials"]])),
            "run_id": run_id(3),
            "local_root": "/elsewhere",
            "approved_sources": [],
        },
        ROOT,
    )
    assert response["fingerprint"] == other["fingerprint"]


@pytest.mark.asyncio
async def test_selected_one_of_five_and_native_aggregation(factory):
    original, plan = factory(names=("A",) * 5)
    replacement, _ = child(factory, original, [2], failures=[])
    response = await replacements.aggregate(
        {"original": original, "parts": [{"evidence": replacement, "parts": []}]}, ROOT
    )
    actual = response["result"]
    originals = Evidence.parse(original).trials
    replacements_native = Evidence.parse(replacement).trials
    expected_trials = originals[:2] + originals[3:] + replacements_native
    expected = native(plan.aggregate(expected_trials))
    assert actual["stats"] == expected["stats"]
    assert actual["trial_results"] == [native(t) for t in expected_trials]
    assert actual["id"] == original["result"]["id"]
    assert actual["n_total_trials"] == 5
    assert "pass_at_k" in next(iter(actual["stats"]["evals"].values()))


@pytest.mark.asyncio
async def test_recursive_disjoint_replacements_keep_failed_evidence(factory):
    original, _ = factory()
    first, _ = child(factory, original, [0, 1])
    second, _ = child(factory, original, [2], number=3)
    grandchild, _ = child(factory, first, [0], number=4)
    result = (
        await replacements.aggregate(
            {
                "original": original,
                "parts": [
                    {
                        "evidence": first,
                        "parts": [{"evidence": grandchild, "parts": []}],
                    },
                    {"evidence": second, "parts": []},
                ],
            },
            ROOT,
        )
    )["result"]
    ids = {t["id"] for t in result["trial_results"]}
    assert ids == {
        first["trials"][1]["id"],
        grandchild["trials"][0]["id"],
        second["trials"][0]["id"],
    }
    assert all(t["exception_info"] is not None for t in result["trial_results"])


def test_normalized_omissions_and_per_trial_authority(factory):
    original, _ = factory()
    fingerprint = Evidence.parse(original).fingerprint(Evidence.parse(original).trials)
    original["config"].pop("quiet")
    original["record"]["harbor_job_config"].pop("quiet")
    original["result"].pop("trial_results")
    original["trials"].reverse()
    source = Evidence.parse(original)
    assert source.fingerprint(source.trials) == fingerprint


@pytest.mark.parametrize(
    "mutation",
    [
        "missing",
        "duplicate",
        "foreign",
        "unfinished",
        "pin",
        "record",
        "lock",
        "task",
        "config",
        "embedded",
        "running",
    ],
)
def test_forged_or_incomplete_source_rejected(factory, mutation):
    original, _ = factory()
    if mutation == "missing":
        original["trials"].pop()
    elif mutation == "duplicate":
        original["trials"][1] = copy.deepcopy(original["trials"][0])
    elif mutation == "foreign":
        original["trials"][0]["config"]["job_id"] = str(uuid4())
    elif mutation == "unfinished":
        original["result"]["finished_at"] = None
    elif mutation == "pin":
        original["lock"]["harbor"]["git_commit_hash"] = "b" * 40
    else:
        _mutate_source(original, mutation)
    if mutation != "embedded":
        original["result"].pop("trial_results", None)
    with pytest.raises(ValueError):
        Evidence.parse(original)


def _mutate_source(original, mutation):
    if mutation == "record":
        original["record"]["harbor_job_config"]["n_attempts"] = 5
    elif mutation == "lock":
        original["lock"]["trials"][0]["agent"]["model_name"] = "wrong"
    elif mutation == "task":
        original["trials"][0]["task_id"]["path"] = "foreign"
    elif mutation == "config":
        original["trials"][0]["config"]["timeout_multiplier"] = 3
    elif mutation == "embedded":
        original["result"]["trial_results"][0]["id"] = str(uuid4())
    else:
        original["result"]["stats"]["n_running_trials"] = 1


@pytest.mark.parametrize(
    "mutation",
    [
        "fingerprint",
        "reference",
        "checksum",
        "digest",
        "config",
        "reuse",
        "overlap",
        "partial",
        "missing_parts",
    ],
)
def test_bad_hierarchy_rejected(factory, mutation):
    original, _ = factory()
    replacement, _ = child(factory, original, [0])
    parts = [{"evidence": replacement, "parts": []}]
    if mutation == "fingerprint":
        replacement["record"]["operator_selection"]["source_fingerprint"] = (
            "sha256:" + "0" * 64
        )
    elif mutation == "reference":
        replacement["record"]["operator_selection"]["original_run_id"] = run_id(99)
    elif mutation == "checksum":
        replacement["trials"][0]["task_checksum"] = "c" * 64
        replacement["result"]["trial_results"] = copy.deepcopy(replacement["trials"])
    elif mutation == "digest":
        replacement["lock"]["trials"][0]["task"]["digest"] = "sha256:" + "c" * 64
    elif mutation == "config":
        replacement["config"]["quiet"] = True
        replacement["record"]["harbor_job_config"]["quiet"] = True
    elif mutation == "reuse":
        replacement["trials"][0]["id"] = original["trials"][0]["id"]
        replacement["result"]["trial_results"] = copy.deepcopy(replacement["trials"])
    else:
        _mutate_parts(factory, original, replacement, parts, mutation)
    with pytest.raises((ValueError, KeyError)):
        replacements.assemble(Evidence.parse(original), parts, set(), set())


def _mutate_parts(factory, original, replacement, parts, mutation):
    if mutation == "overlap":
        other, _ = child(factory, original, [0], number=3)
        parts.append({"evidence": other, "parts": []})
    elif mutation == "partial":
        grandchild, _ = child(factory, replacement, [0], number=3)
        grandchild["result"]["finished_at"] = None
        parts[0]["parts"] = [{"evidence": grandchild, "parts": []}]
    else:
        del parts[0]["parts"]


@pytest.mark.parametrize("ids", [[], ["foreign"], [str(uuid4())]])
def test_invalid_selection(factory, ids):
    original, _ = factory()
    with pytest.raises(ValueError):
        Evidence.parse(original).select(ids)


def test_reward_and_duplicate_selection_rejected(factory):
    original, _ = factory(failures=[])
    source = Evidence.parse(original)
    trial_id = original["trials"][0]["id"]
    with pytest.raises(ValueError, match="exception_info"):
        source.select([trial_id])
    with pytest.raises(ValueError, match="distinct"):
        source.select([trial_id, trial_id])


@pytest.mark.asyncio
async def test_original_dataset_metrics_used_without_task_download(
    factory, monkeypatch
):
    original, _ = factory(names=("A", "A", "B"))
    config = original["config"]
    tasks = [TaskConfig.model_validate(t) for t in config["tasks"]]
    config["datasets"] = [{"repo": f"{URL}@{SHA}", "path": "tasks"}]
    config["tasks"] = []
    original["record"]["harbor_job_config"] = copy.deepcopy(config)
    replacement, _ = child(factory, original, [0])
    monkeypatch.setattr(JobPlan, "resolve_task_configs", AsyncMock(return_value=tasks))
    monkeypatch.setattr(launch, "check_metrics", AsyncMock())
    metrics = AsyncMock(return_value={"adhoc": [Mean()]})
    monkeypatch.setattr(JobPlan, "resolve_metrics", metrics)
    monkeypatch.setattr(
        JobPlan, "cache_tasks", AsyncMock(side_effect=AssertionError("no downloads"))
    )
    await replacements.aggregate(
        {"original": original, "parts": [{"evidence": replacement, "parts": []}]}, ROOT
    )
    assert metrics.call_args.args[0].datasets
    assert metrics.call_args.args[0].tasks == []


@pytest.mark.asyncio
async def test_source_multiplicity_cannot_be_forged(factory):
    original, _ = factory()
    original["config"]["tasks"].pop()
    original["record"]["harbor_job_config"] = copy.deepcopy(original["config"])
    with pytest.raises(ValueError, match="multiplicity"):
        await replacements.admit(Evidence.parse(original), [], ROOT)


def test_unsupported_non_cartesian_and_owned_paths(factory):
    original, _ = factory()
    source = Evidence.parse(original)
    for run, root in [
        (source.run_id, "/data"),
        ("bad", "/data"),
        (run_id(2), "relative"),
    ]:
        with pytest.raises(ValueError):
            derive(source, source.trials, run, Path(root))
    original["config"]["agents"] *= 2
    original["record"]["harbor_job_config"] = copy.deepcopy(original["config"])
    with pytest.raises(ValueError, match="Cartesian"):
        Evidence.parse(original)


def test_missing_uuid_is_not_generated(factory):
    original, _ = factory()
    original["result"].pop("trial_results")
    original["trials"][0].pop("id")
    with pytest.raises(ValueError, match="never generated"):
        Evidence.parse(original)


@pytest.mark.parametrize("operation", ["replacement_review", "replacement_aggregate"])
def test_launch_operation_dispatch_and_large_native_payload(
    factory, monkeypatch, capsys, operation
):
    import io
    import json
    import sys

    original, _ = factory(names=("A",) * 440)
    original["result"].pop("trial_results")
    for trial in original["trials"]:
        trial["exception_info"]["exception_traceback"] = "native trace\n" * 1000
    payload = json.dumps({"operation": operation, "original": original}).encode()
    assert 1024 * 1024 < len(payload) < 32 * 1024 * 1024
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(payload)))
    monkeypatch.setattr(sys, "argv", ["launch", str(ROOT)])
    handler = AsyncMock(return_value={"result": original["result"]})
    monkeypatch.setattr(
        replacements,
        "review" if operation == "replacement_review" else "aggregate",
        handler,
    )
    launch.main()
    assert json.loads(capsys.readouterr().out)["result"]["n_total_trials"] == 440
    assert len(handler.call_args.args[0]["original"]["trials"]) == 440


def test_launch_rejects_above_32_mib(monkeypatch, capsys):
    import io
    import sys

    monkeypatch.setattr(
        sys, "stdin", io.TextIOWrapper(io.BytesIO(b" " * (32 * 1024 * 1024 + 1)))
    )
    with pytest.raises(SystemExit):
        launch.main()
    assert "exceeds 32 MiB" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_full_native_aggregate_exceeds_one_mib(factory):
    import json

    original, _ = factory(names=("A",) * 440)
    original["result"].pop("trial_results")
    for trial in original["trials"]:
        trial["exception_info"]["exception_traceback"] = "native trace\n" * 1000
    result = await replacements.aggregate({"original": original, "parts": []}, ROOT)
    assert len(json.dumps(result).encode()) > 1024 * 1024
    assert result["result"]["trial_results"] == original["trials"]


@pytest.mark.parametrize("field", ["digest", "checksum"])
def test_ambiguous_duplicate_task_evidence_rejected(factory, field):
    original, _ = factory(names=("A", "A"))
    if field == "digest":
        original["lock"]["trials"][0]["task"]["digest"] = "sha256:" + "0" * 64
    else:
        original["trials"][0]["task_checksum"] = "0" * 64
        original["result"].pop("trial_results")
    with pytest.raises(ValueError, match="Ambiguous"):
        Evidence.parse(original)


def test_reused_native_job_uuid_rejected(factory):
    original, _ = factory()
    replacement, _ = child(factory, original, [0])
    replacement["result"]["id"] = original["result"]["id"]
    replacement["trials"][0]["config"]["job_id"] = original["result"]["id"]
    replacement["result"]["trial_results"] = copy.deepcopy(replacement["trials"])
    with pytest.raises(ValueError, match="job UUID"):
        replacements.assemble(
            Evidence.parse(original),
            [{"evidence": replacement, "parts": []}],
            set(),
            set(),
        )


@pytest.mark.asyncio
async def test_private_descendant_review_without_ancestor_evidence_fails_closed(
    factory,
):
    import json

    original, _ = factory()
    replacement, _ = child(factory, original, [0])
    replacement = json.loads(
        json.dumps(replacement).replace(
            URL, "https://huggingface.co/datasets/example-org/example-dataset.git"
        )
    )
    with pytest.raises(ValueError, match="Missing replacement ancestor"):
        await replacements.review(
            {
                "original": replacement,
                "trial_ids": [replacement["trials"][0]["id"]],
                "run_id": run_id(3),
                "local_root": "/data",
                "approved_sources": [],
            },
            ROOT,
        )

"""Source SDK reads must never copy source output into the new run."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from harbor.job_plan import JobPlan
from harbor.models.trial.config import TaskConfig
from huggingface_hub import BucketFile, HfApi
from test_replacements import child, run_id

from harbor_hf_agents import launch, parent_worker, replacement_preflight
from harbor_hf_agents.bucket_artifacts import BucketArtifacts
from harbor_hf_agents.replacement_evidence import Evidence, derive, native

pytest_plugins = ["test_replacements"]


@pytest.fixture
def source_storage(factory, tmp_path):
    original, _ = factory()
    replacement, _ = child(factory, original, [0])
    run_dir = tmp_path / "local/runs" / run_id(2)
    config = derive(
        Evidence.parse(original),
        Evidence.parse(original).select([original["trials"][0]["id"]]),
        run_id(2),
        tmp_path / "local",
    )
    record = replacement["record"]
    record["harbor_job_config"] = native(config)
    api = Mock(spec=HfApi)
    artifacts = BucketArtifacts(api, "<namespace>/<artifact-bucket>", run_dir)
    files = {}
    destinations = []

    def store(bundle):
        prefix = f"runs/{bundle['record']['run_id']}"
        files[f"{prefix}/run.json"] = bundle["record"]
        for name in ("config", "lock", "result"):
            files[f"{prefix}/job/{name}.json"] = bundle[name]
        for trial in bundle["trials"]:
            files[f"{prefix}/job/{trial['trial_name']}/result.json"] = trial
            files[f"{prefix}/job/{trial['trial_name']}/agent/output.json"] = {
                "never": "download"
            }

    store(original)

    def listing(bucket, *, prefix, recursive):
        assert bucket == artifacts.bucket_id and recursive
        return [
            BucketFile(type="file", path=path, size=1, xetHash="0" * 64)
            for path in files
            if path.startswith(prefix)
        ]

    def download(bucket, transfers, *, raise_on_missing_files):
        assert bucket == artifacts.bucket_id and raise_on_missing_files
        for source, target in transfers:
            assert not target.is_relative_to(run_dir)
            assert "/agent/" not in source
            destinations.append(target)
            target.write_text(json.dumps(files[source]))

    api.list_bucket_tree.side_effect = listing
    api.download_bucket_files.side_effect = download
    return artifacts, record, config, original, files, destinations, store


@pytest.mark.asyncio
async def test_preflight_reads_only_native_evidence_and_discards_it(source_storage):
    artifacts, record, config, _, _, destinations, _ = source_storage
    await replacement_preflight.preflight(artifacts, record, config)
    assert destinations and all(not path.exists() for path in destinations)
    assert not artifacts.run_dir.exists()
    artifacts.api.sync_bucket.assert_not_called()
    artifacts.api.batch_bucket_files.assert_not_called()


@pytest.mark.parametrize(
    "mutation", ["fingerprint", "config", "unfinished", "missing", "foreign", "cycle"]
)
def test_preflight_fail_closed(source_storage, mutation):
    artifacts, record, config, original, files, destinations, _ = source_storage
    prefix = f"runs/{original['record']['run_id']}/job/"
    if mutation == "fingerprint":
        record["operator_selection"]["source_fingerprint"] = "wrong"
    elif mutation == "config":
        config.quiet = True
    elif mutation == "unfinished":
        files[prefix + "pending/config.json"] = {}
    elif mutation == "missing":
        del files[prefix + "lock.json"]
    elif mutation == "foreign":
        record["operator_selection"]["original_run_id"] = "../escape"
    else:
        original["record"]["operator_selection"] = {
            "original_run_id": original["record"]["run_id"]
        }
    with pytest.raises((ValueError, KeyError)):
        replacement_preflight.validate_preflight(artifacts, record, config)
    assert all(not path.exists() for path in destinations)
    artifacts.api.batch_bucket_files.assert_not_called()


@pytest.mark.asyncio
async def test_parent_rejection_precedes_job_create(source_storage, monkeypatch):
    artifacts, record, config, _, _, _, _ = source_storage
    monkeypatch.setenv("HARBOR_HF_RUN_ID", artifacts.run_dir.name)
    monkeypatch.setenv("HARBOR_HF_LOCAL_ROOT", str(artifacts.run_dir.parents[1]))
    monkeypatch.setenv("HARBOR_HF_BUCKET_ID", artifacts.bucket_id)
    monkeypatch.setattr(parent_worker, "BucketArtifacts", lambda *args: artifacts)
    monkeypatch.setattr(artifacts, "restore", AsyncMock())
    record["operator_selection"]["source_fingerprint"] = "changed"
    artifacts.run_dir.mkdir(parents=True)
    (artifacts.run_dir / "run.json").write_text(json.dumps(record))
    create = AsyncMock()
    monkeypatch.setattr(parent_worker.Job, "create", create)
    with pytest.raises(ValueError, match="fingerprint"):
        await parent_worker.run_parent()
    create.assert_not_called()


def test_private_hf_tasks_require_exact_original_dataset_provenance(
    source_storage, monkeypatch
):
    artifacts, record, config, original, _, _, store = source_storage
    url = "https://huggingface.co/datasets/example-org/example-dataset.git"

    def replace_url(value):
        return json.loads(
            json.dumps(value).replace(
                "https://github.com/example-org/example-task.git", url
            )
        )

    original = replace_url(original)
    original["config"]["datasets"] = [{"repo": url + "@" + "a" * 40, "path": "tasks"}]
    tasks = [TaskConfig.model_validate(t) for t in original["config"]["tasks"]]
    original["config"]["tasks"] = []
    original["record"]["harbor_job_config"] = copy.deepcopy(original["config"])
    store(original)
    source = Evidence.parse(original)
    selected = source.select(record["operator_selection"]["trial_ids"])
    config = derive(
        source, selected, artifacts.run_dir.name, artifacts.run_dir.parents[1]
    )
    record["harbor_job_config"] = native(config)
    record["operator_selection"]["source_fingerprint"] = source.fingerprint(selected)
    monkeypatch.setenv("HF_TOKEN", "synthetic-test-not-a-credential")
    monkeypatch.setattr(launch.shutil, "which", lambda _: "/usr/bin/git-lfs")
    monkeypatch.setattr(JobPlan, "resolve_task_configs", AsyncMock(return_value=tasks))
    with pytest.raises(ValueError, match="admitted dataset"):
        launch.check_sources(config)
    replacement_preflight.validate_preflight(artifacts, record, config)
    config.tasks[0].path = Path("foreign")
    with pytest.raises(ValueError, match="differs"):
        replacement_preflight.validate_preflight(artifacts, record, config)


def test_recursive_parent_source_is_independently_validated(source_storage, factory):
    artifacts, _, _, original, _, destinations, store = source_storage
    intermediate, _ = child(factory, original, [0], number=4)
    store(intermediate)
    source = Evidence.parse(intermediate)
    selected = source.select([intermediate["trials"][0]["id"]])
    config = derive(
        source, selected, artifacts.run_dir.name, artifacts.run_dir.parents[1]
    )
    record = {
        "harbor_job_config": native(config),
        "operator_selection": {
            "original_run_id": source.run_id,
            "trial_ids": [str(t.id) for t in selected],
            "source_fingerprint": source.fingerprint(selected),
        },
    }
    replacement_preflight.validate_preflight(artifacts, record, config)
    assert all(not path.exists() for path in destinations)
    intermediate["record"]["operator_selection"]["source_fingerprint"] = "changed"
    with pytest.raises(ValueError, match="fingerprint"):
        replacement_preflight.validate_preflight(artifacts, record, config)


def test_malformed_source_listing_rejected(source_storage):
    artifacts, _, _, original, files, _, _ = source_storage
    prefix = f"runs/{original['record']['run_id']}/job/"
    files[prefix + "../escape/result.json"] = {}
    with pytest.raises(ValueError, match="path"):
        replacement_preflight._source_files(artifacts, original["record"]["run_id"])
    artifacts.api.list_bucket_tree.side_effect = lambda *args, **kwargs: [
        BucketFile(type="file", path="foreign/job/file.json", size=1, xetHash="0" * 64)
    ]
    with pytest.raises(ValueError, match="escaped"):
        replacement_preflight._source_files(artifacts, original["record"]["run_id"])


def test_source_trial_path_must_match_native_identity(source_storage):
    artifacts, record, config, original, files, _, _ = source_storage
    prefix = f"runs/{original['record']['run_id']}/job/"
    for suffix in ("result.json", "agent/output.json"):
        files[prefix + "renamed/" + suffix] = files.pop(prefix + "trial-0/" + suffix)
    with pytest.raises(ValueError, match="artifact path"):
        replacement_preflight.validate_preflight(artifacts, record, config)


def test_private_descendant_sdk_ancestry_uses_shared_validation(
    source_storage, factory, monkeypatch
):
    artifacts, _, _, original, files, _, store = source_storage
    url = "https://huggingface.co/datasets/example-org/example-dataset.git"
    config = parent_worker.JobConfig.model_validate(original["config"])
    for task in config.tasks:
        task.git_url = url
    original, _ = factory(config=config)
    tasks = [TaskConfig.model_validate(t) for t in original["config"]["tasks"]]
    original["config"]["datasets"] = [{"repo": f"{url}@{'a' * 40}", "path": "tasks"}]
    original["config"]["tasks"] = []
    original["record"]["harbor_job_config"] = copy.deepcopy(original["config"])
    native_resolve = JobPlan.resolve_task_configs

    async def resolve(config):
        return tasks if config.datasets else await native_resolve(config)

    monkeypatch.setattr(JobPlan, "resolve_task_configs", resolve)
    monkeypatch.setenv("HF_TOKEN", "synthetic-test-not-a-credential")
    monkeypatch.setattr(launch.shutil, "which", lambda _: "/usr/bin/git-lfs")
    store(original)
    intermediate, _ = child(factory, original, [0, 1, 2], number=4)
    store(intermediate)
    source = Evidence.parse(intermediate)
    selected = source.select([str(t.id) for t in source.trials])
    config = derive(
        source, selected, artifacts.run_dir.name, artifacts.run_dir.parents[1]
    )
    record = {
        "harbor_job_config": native(config),
        "operator_selection": {
            "original_run_id": source.run_id,
            "trial_ids": [str(t.id) for t in source.trials],
            "source_fingerprint": source.fingerprint(source.trials),
        },
    }
    replacement_preflight.validate_preflight(artifacts, record, config)
    del files[f"runs/{original['record']['run_id']}/job/lock.json"]
    with pytest.raises(KeyError):
        replacement_preflight.validate_preflight(artifacts, record, config)


@pytest.mark.asyncio
@pytest.mark.parametrize("private", [False, True])
async def test_real_native_source_fingerprint_crosslanguage_gate(
    source_storage, factory, monkeypatch, tmp_path, private
):
    from harbor.tasks.client import TaskClient
    from replacement_compiler_fixture import native_transport_roundtrip
    from test_replacements import ROOT, SHA

    from harbor_hf_agents import replacements

    git = AsyncMock(side_effect=AssertionError("Offline gate must not invoke Git"))
    monkeypatch.setattr(TaskClient, "_run_git", git)
    artifacts, _, _, original, _, _, store = source_storage
    if private:
        url = "https://huggingface.co/datasets/example-org/example-dataset.git"
        config = parent_worker.JobConfig.model_validate(original["config"])
        for task in config.tasks:
            task.git_url = url
            task.source = "example-dataset"
        original, _ = factory(config=config)
        tasks = [TaskConfig.model_validate(t) for t in original["config"]["tasks"]]
        original["config"]["datasets"] = [{"repo": f"{url}@{SHA}", "path": "tasks"}]
        original["config"]["tasks"] = []
        original["record"]["harbor_job_config"] = copy.deepcopy(original["config"])
        # Only external metadata is mocked; native DatasetConfig/JobPlan resolve it.
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
        monkeypatch.setenv("HF_TOKEN", "synthetic-test-not-a-credential")
        monkeypatch.setattr(launch.shutil, "which", lambda _: "/usr/bin/git-lfs")
    # Complete durable metadata BEFORE native hashing, never forge a fingerprint.
    original["record"].update(
        created_at="2026-01-01T00:00:00Z",
        submitted_by="test-operator",
        role="final",
        submission={
            "benchmark": {"name": "terminal-bench-2-1", "preset": "all-tasks-1-trial"},
            "model": {
                "id": "example/model",
                "provider": "provider",
                "reasoning_effort": "off",
            },
            "harness": {"agent": "pi", "version": "0.84.4"},
            "cost_ceiling_usd": 10,
        },
    )
    store(original)
    request = {
        "original": original,
        "original_ancestors": [],
        "trial_ids": [t["id"] for t in original["trials"]],
        "run_id": artifacts.run_dir.name,
        "local_root": str(artifacts.run_dir.parents[1]),
    }
    response = await replacements.review(request, ROOT)
    record = native_transport_roundtrip(tmp_path, request, response)
    source = Evidence.parse(original)
    assert record["operator_selection"]["source_fingerprint"] == source.fingerprint(
        source.select(request["trial_ids"])
    )
    config = parent_worker.JobConfig.model_validate(record["harbor_job_config"])
    replacement, _ = factory(config=config, number=2)
    replacement["record"] = record
    replacements.request_ancestry(Evidence.parse(replacement), [original])
    await replacement_preflight.preflight(artifacts, record, config)
    unchanged = copy.deepcopy(original)
    original["trials"][0]["verifier_result"]["rewards"]["reward"] = 0.25
    if original["result"].get("trial_results"):
        original["result"]["trial_results"] = copy.deepcopy(original["trials"])
    store(original)
    with pytest.raises(ValueError, match="fingerprint"):
        await replacement_preflight.preflight(artifacts, record, config)
    store(unchanged)
    original = unchanged
    record["operator_selection"]["source_fingerprint"] = response["fingerprint"][7:]
    with pytest.raises(ValueError, match="fingerprint"):
        replacements.request_ancestry(Evidence.parse(replacement), [original])
    with pytest.raises(ValueError, match="fingerprint"):
        await replacement_preflight.preflight(artifacts, record, config)
    git.assert_not_awaited()

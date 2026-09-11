"""Offline parent integration: native Harbor lifecycle and an in-memory Bucket."""

import asyncio
import json
import shutil
from unittest.mock import AsyncMock

import pytest
import test_bucket_artifacts as memory
from harbor.models.agent.context import AgentContext
from harbor.models.verifier.result import VerifierResult
from harbor.trial.single_step import SingleStepTrial
from harbor.trial.trial import Trial

from harbor_hf_agents import parent_worker
from harbor_hf_agents.launch import REVISION

RUN_ID = "run-0123456789abcdef01234567"
SECRET = "synthetic-parent-fixture-not-a-credential"


@pytest.fixture
def parent(tmp_path, monkeypatch):
    local = tmp_path / "local"
    run_dir = local / "runs" / RUN_ID
    task = tmp_path / "task"
    task.mkdir()
    (task / "task.toml").write_text(
        'version = "1.0"\n[environment]\ndocker_image = "example-image:fixed"\n'
    )
    (task / "instruction.md").write_text("Offline parent lifecycle test.")
    (task / "tests").mkdir()
    (task / "tests" / "test.sh").write_text("exit 0\n")
    config = {
        "job_name": "job",
        "jobs_dir": str(run_dir),
        "tasks": [{"path": str(task)}],
        "agents": [{"name": "nop", "env": {"API_KEY": "${API_KEY}"}}],
        "environment": {
            "import_path": ("harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment"),
            "kwargs": {"run_label": RUN_ID},
        },
        "quiet": True,
        "n_attempts": 2,
        "n_concurrent_trials": 2,
        "retry": {"max_retries": 0},
    }
    record = {
        "schema_version": "v1",
        "run_id": RUN_ID,
        "harbor_revision": REVISION,
        "submission": {"cost_ceiling_usd": 10},
        "harbor_job_config": config,
    }
    monkeypatch.setattr(memory, "PREFIX", f"runs/{RUN_ID}")
    remote = memory.MemoryBucket()
    remote.files = {
        f"{memory.PREFIX}/run.json": json.dumps(record).encode(),
        f"{memory.PREFIX}/state.json": b'{"desired_state":"run"}',
    }
    monkeypatch.setattr(parent_worker, "HfApi", lambda: remote.api)
    monkeypatch.setenv("API_KEY", SECRET)
    monkeypatch.setenv("HARBOR_HF_RUN_ID", RUN_ID)
    monkeypatch.setenv("HARBOR_HF_LOCAL_ROOT", str(local))
    monkeypatch.setenv("HARBOR_HF_BUCKET_ID", memory.BUCKET)
    # Source admission has separate tests; this fixture uses an offline task.
    monkeypatch.setattr(parent_worker, "check_sources", lambda _: None)
    for method in ("_prepare", "_close_bridge", "_stop_agent_environment"):
        monkeypatch.setattr(Trial, method, AsyncMock())
    monkeypatch.setattr(SingleStepTrial, "_recover_outputs", AsyncMock())
    executed = []

    async def execute(trial):
        executed.append(trial.config.trial_name)
        # Both native START identities must be observable before either END.
        await asyncio.sleep(0.02)
        trial.paths.verifier_dir.mkdir(exist_ok=True)
        trial.paths.reward_text_path.write_text("1\n")
        (trial.paths.agent_dir / "run.log").write_text(SECRET)
        trial.result.agent_result = AgentContext(cost_usd=0.1)
        trial.result.verifier_result = VerifierResult(rewards={"reward": 1})

    monkeypatch.setattr(SingleStepTrial, "_run", execute)
    return run_dir, remote, record, executed, execute


@pytest.mark.asyncio
async def test_parent_local_rewards_scrubbed_live_uploads_and_native_resume(parent):
    run_dir, remote, _, executed, _ = parent
    original_control = {
        key: value for key, value in remote.files.items() if "/job/" not in key
    }
    await parent_worker.run_parent()
    assert len(executed) == 2
    result_key = f"{memory.PREFIX}/job/result.json"
    result = json.loads(remote.files[result_key])
    assert result["finished_at"] is not None
    assert result["stats"]["n_completed_trials"] == 2
    rewards = [
        value for key, value in remote.files.items() if key.endswith("reward.txt")
    ]
    assert rewards == [b"1\n", b"1\n"]
    logs = [value for key, value in remote.files.items() if key.endswith("run.log")]
    assert logs == [b"[REDACTED]", b"[REDACTED]"]
    assert all(remote.files[key] == value for key, value in original_control.items())
    assert sum("/attempt-costs/" in key for key in remote.files) == 2
    assert remote.events[-1] == ("batch", (result_key,))
    first_trial_result = next(
        index
        for index, (kind, names) in enumerate(remote.events)
        if kind == "batch"
        and any(name.endswith("/result.json") and name != result_key for name in names)
    )
    for name in executed:
        lock = f"{memory.PREFIX}/job/{name}/lock.json"
        assert any(lock in names for _, names in remote.events[:first_trial_result])
    # Simulate replacement parent storage, not another trial scheduler.
    shutil.rmtree(run_dir)
    await parent_worker.run_parent()
    assert len(executed) == 2
    assert sum("/attempt-costs/" in key for key in remote.files) == 2


@pytest.mark.asyncio
async def test_write_failure_stops_before_inference(parent):
    _, remote, _, executed, _ = parent
    remote.fail_target = f"{memory.PREFIX}/job/config.json"
    with pytest.raises(BaseExceptionGroup):
        await parent_worker.run_parent()
    assert executed == []
    assert not any(key.endswith("reward.txt") for key in remote.files)


@pytest.mark.asyncio
async def test_upload_failure_never_publishes_finished_aggregate(parent):
    _, remote, _, _, _ = parent
    remote.fail_target = f"{memory.PREFIX}/job/result.json"
    with pytest.raises(BaseExceptionGroup):
        await parent_worker.run_parent()
    assert f"{memory.PREFIX}/job/result.json" not in remote.files


@pytest.mark.asyncio
async def test_controlled_start_preserves_control_and_does_not_execute(parent):
    _, remote, _, executed, _ = parent
    state_key = f"{memory.PREFIX}/state.json"
    remote.files[state_key] = b'{"desired_state":"paused"}'
    await parent_worker.run_parent()
    assert executed == []
    assert remote.files[state_key] == b'{"desired_state":"paused"}'
    assert not any(key.endswith("reward.txt") for key in remote.files)


@pytest.mark.asyncio
async def test_trial_failure_is_scrubbed_and_reported_during_run(parent, monkeypatch):
    _, remote, _, _, execute = parent

    async def fail(trial):
        await execute(trial)
        raise ValueError(SECRET)

    monkeypatch.setattr(SingleStepTrial, "_run", fail)
    await parent_worker.run_parent()
    results = [
        json.loads(value)
        for key, value in remote.files.items()
        if key.endswith("/result.json") and key.count("/") == 4
    ]
    assert len(results) == 2
    assert all(r["exception_info"]["exception_type"] == "ValueError" for r in results)
    assert all(SECRET not in json.dumps(r) for r in results)
    assert f"{memory.PREFIX}/job/job.log" not in remote.files
    assert all(SECRET.encode() not in value for value in remote.files.values())


@pytest.mark.asyncio
async def test_scrub_failure_never_uploads_trial_output(parent, monkeypatch):
    _, remote, _, _, _ = parent

    def fail_scrub(trial):
        raise RuntimeError("synthetic scrub failure")

    monkeypatch.setattr(Trial, "_scrub_jobs_dir", fail_scrub)
    with pytest.raises(BaseExceptionGroup):
        await parent_worker.run_parent()
    assert not any(key.endswith("run.log") for key in remote.files)
    assert not any(key.endswith("reward.txt") for key in remote.files)


@pytest.mark.asyncio
@pytest.mark.parametrize("ceiling", [0.05, 0.15])
async def test_cost_receipts_persist_on_stop_or_final_boundary(parent, ceiling):
    _, remote, record, _, _ = parent
    record["submission"]["cost_ceiling_usd"] = ceiling
    remote.files[f"{memory.PREFIX}/run.json"] = json.dumps(record).encode()
    await parent_worker.run_parent()
    receipts = [
        json.loads(value)
        for key, value in remote.files.items()
        if "/attempt-costs/" in key
    ]
    assert receipts
    assert all(receipt["cost_usd"] == 0.1 for receipt in receipts)


@pytest.mark.asyncio
async def test_trial_upload_failure_cannot_publish_terminal_result(parent, monkeypatch):
    _, remote, _, _, execute = parent

    async def fail_upload(trial):
        await execute(trial)
        remote.fail_target = (
            f"{memory.PREFIX}/job/{trial.config.trial_name}/verifier/reward.txt"
        )

    monkeypatch.setattr(SingleStepTrial, "_run", fail_upload)
    with pytest.raises(BaseExceptionGroup):
        await parent_worker.run_parent()
    aggregate = json.loads(remote.files[f"{memory.PREFIX}/job/result.json"])
    assert aggregate["finished_at"] is None


@pytest.mark.asyncio
async def test_native_retry_backoff_snapshot_resumes_missing_attempt(
    parent, monkeypatch
):
    from harbor.trial.queue import TrialQueue

    run_dir, remote, record, executed, execute = parent
    config = record["harbor_job_config"]
    config["n_attempts"] = 1
    config["n_concurrent_trials"] = 1
    config["retry"]["max_retries"] = 1
    remote.files[f"{memory.PREFIX}/run.json"] = json.dumps(record).encode()

    async def fail(trial):
        await execute(trial)
        raise ValueError("synthetic retryable failure")

    def stopped_backoff(queue, attempt):
        del queue, attempt
        # This runs after native removal, before retry sleep/new START.
        assert not (run_dir / "job" / executed[-1]).exists()
        assert f"{memory.PREFIX}/job/{executed[-1]}/result.json" not in remote.files
        assert any("/attempt-costs/" in key for key in remote.files)
        raise RuntimeError("synthetic parent interruption during backoff")

    monkeypatch.setattr(SingleStepTrial, "_run", fail)
    monkeypatch.setattr(TrialQueue, "_calculate_backoff_delay_sec", stopped_backoff)
    with pytest.raises(BaseExceptionGroup):
        await parent_worker.run_parent()
    shutil.rmtree(run_dir)
    monkeypatch.setattr(SingleStepTrial, "_run", execute)
    await parent_worker.run_parent()
    assert len(executed) == 2  # Harbor, not the adapter, schedules missing work.
    aggregate = json.loads(remote.files[f"{memory.PREFIX}/job/result.json"])
    assert aggregate["finished_at"] is not None
    assert sum("/attempt-costs/" in key for key in remote.files) == 2


@pytest.mark.asyncio
async def test_snapshots_wait_for_native_completion_writer_lock(parent):
    from types import SimpleNamespace

    from harbor_hf_agents.bucket_artifacts import BucketArtifacts

    run_dir, remote, _, _, _ = parent
    run_dir.mkdir(parents=True)
    native_lock = asyncio.Lock()
    job = SimpleNamespace(_trial_completion_lock=native_lock)
    artifacts = BucketArtifacts(remote.api, memory.BUCKET, run_dir)
    artifacts.started = AsyncMock()
    started, _ = parent_worker._persistence_hooks(job, artifacts, AsyncMock())
    await native_lock.acquire()
    pending = asyncio.create_task(started(SimpleNamespace(trial_name="trial")))
    await asyncio.sleep(0)
    artifacts.started.assert_not_awaited()
    native_lock.release()
    await pending
    artifacts.started.assert_awaited_once_with("trial")

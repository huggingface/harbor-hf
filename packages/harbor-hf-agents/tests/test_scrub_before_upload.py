"""Offline contracts using native construction, run, finalization and retries."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from harbor.models.job.config import RetryConfig
from harbor.models.trial.config import AgentConfig, TaskConfig, TrialConfig
from harbor.trial.hooks import TrialEvent
from harbor.trial.queue import TrialQueue
from harbor.trial.single_step import SingleStepTrial
from harbor.trial.trial import Trial

from harbor_hf_agents import launch
from harbor_hf_agents.scrub_before_upload import SCRUB_REVISION, scrub_before_upload

SYNTHETIC_SECRET = "synthetic-scrub-test-value-not-a-credential"


@pytest.fixture
def lifecycle(tmp_path, monkeypatch):
    task = tmp_path / "task"
    task.mkdir()
    (task / "task.toml").write_text(
        'version = "1.0"\n[environment]\ndocker_image = "example-image:fixed"\n'
    )
    (task / "instruction.md").write_text("Offline lifecycle test.")
    (task / "tests").mkdir()
    (task / "tests" / "test.sh").write_text("exit 0\n")
    config = TrialConfig(
        task=TaskConfig(path=task),
        agent=AgentConfig(name="nop", env={"API_KEY": SYNTHETIC_SECRET}),
        trials_dir=tmp_path / "job",
        trial_name="trial",
    )
    # Only external execution is stubbed. Native construction and persistence run.
    for method in ("_prepare", "_close_bridge", "_stop_agent_environment"):
        monkeypatch.setattr(Trial, method, AsyncMock())
    monkeypatch.setattr(SingleStepTrial, "_recover_outputs", AsyncMock())
    events = []
    native_scrub = Trial._scrub_jobs_dir

    def scrub(trial):
        assert trial.paths.result_path.exists()
        events.append("scrub")
        native_scrub(trial)

    monkeypatch.setattr(Trial, "_scrub_jobs_dir", scrub)

    async def run(trial):
        (trial.paths.trial_dir / "artifact.txt").write_text(SYNTHETIC_SECRET)
        events.append("run")

    monkeypatch.setattr(SingleStepTrial, "_run", run)
    return config, events, run


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "failure", "cancellation"])
async def test_native_lifecycle_order(lifecycle, monkeypatch, outcome):
    config, events, run = lifecycle

    async def execute(trial):
        await run(trial)
        if outcome == "failure":
            raise ValueError(SYNTHETIC_SECRET)
        if outcome == "cancellation":
            raise asyncio.CancelledError(SYNTHETIC_SECRET)

    monkeypatch.setattr(SingleStepTrial, "_run", execute)
    original = Trial._emit
    with scrub_before_upload() as state:
        trial = await Trial.create(config)

        async def end(event):
            events.append("end")
            assert event.result is trial.result
            assert SYNTHETIC_SECRET not in trial.paths.result_path.read_text()
            assert (trial.paths.trial_dir / "artifact.txt").read_text() == "[REDACTED]"
            if outcome != "success":
                assert SYNTHETIC_SECRET in event.result.model_dump_json()

        async def cancel(event):
            assert event.event == TrialEvent.CANCEL
            events.append("cancel")

        trial.add_hook(TrialEvent.END, end)
        trial.add_hook(TrialEvent.CANCEL, cancel)
        if outcome == "cancellation":
            with pytest.raises(asyncio.CancelledError):
                await trial.run()
        else:
            result = await trial.run()
            assert (result.exception_info is None) == (outcome == "success")
        assert not state.failed
    assert Trial._emit is original
    assert events == [
        "run",
        *(["cancel"] if outcome == "cancellation" else []),
        "scrub",
        "end",
        "scrub",
    ]


@pytest.mark.asyncio
async def test_native_queue_retries_scrub_each_actual_trial(lifecycle, monkeypatch):
    config, events, run = lifecycle
    trials = []

    async def execute(trial):
        trials.append(trial)
        await run(trial)
        if len(trials) == 1:
            raise ValueError(SYNTHETIC_SECRET)

    monkeypatch.setattr(SingleStepTrial, "_run", execute)
    queue = TrialQueue(1, RetryConfig(max_retries=1, min_wait_sec=0, max_wait_sec=0))

    async def end(event):
        events.append("end")
        assert event.result is trials[-1].result
        assert SYNTHETIC_SECRET not in trials[-1].paths.result_path.read_text()

    queue.on_trial_ended(end)
    with scrub_before_upload() as state:
        result = await queue.submit(config)
        assert not state.failed
    assert result.exception_info is None
    assert len(trials) == 2
    assert trials[0] is not trials[1]
    assert events == ["run", "scrub", "end", "scrub"] * 2


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
async def test_scrub_failure_blocks_callbacks_and_final_upload(
    lifecycle, monkeypatch, error_type
):
    config, events, _ = lifecycle
    native_scrub = Trial._scrub_jobs_dir
    calls = 0

    def fail_once(trial):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise error_type("synthetic scrub failure")
        native_scrub(trial)

    monkeypatch.setattr(Trial, "_scrub_jobs_dir", fail_once)
    original = Trial._emit
    upload = AsyncMock()
    with scrub_before_upload() as state:
        trial = await Trial.create(config)
        trial.add_hook(TrialEvent.END, upload)
        with pytest.raises(error_type, match="synthetic scrub failure"):
            await trial.run()
        assert state.failed
        # Parent must use this veto even when it catches the original failure.
        if not state.failed:
            await upload()
        with pytest.raises(RuntimeError, match="uploads blocked"):
            await trial._emit(TrialEvent.END)
    upload.assert_not_awaited()
    assert calls == 2  # Native finally still runs after the early scrub failure.
    assert events == ["run", "scrub"]
    assert Trial._emit is original


@pytest.mark.asyncio
async def test_end_callback_error_propagates_and_finally_scrubs(lifecycle):
    config, events, _ = lifecycle
    original = Trial._emit
    with scrub_before_upload() as state:
        trial = await Trial.create(config)

        async def fail(event):
            events.append("end")
            (trial.paths.trial_dir / "artifact.txt").write_text(SYNTHETIC_SECRET)
            raise RuntimeError("synthetic hook failure")

        trial.add_hook(TrialEvent.END, fail)
        with pytest.raises(RuntimeError, match="synthetic hook failure"):
            await trial.run()
        assert not state.failed
        assert (trial.paths.trial_dir / "artifact.txt").read_text() == "[REDACTED]"
    assert Trial._emit is original
    assert events == ["run", "scrub", "end", "scrub"]


def test_real_installed_revision():
    assert SCRUB_REVISION == launch.REVISION
    launch.check_revision()


@pytest.mark.parametrize("mismatch", ["launch", "installed"])
def test_revision_mismatch_does_not_patch(monkeypatch, mismatch):
    original = Trial._emit
    if mismatch == "launch":
        monkeypatch.setattr(launch, "REVISION", "0" * 40)
    else:

        class Distribution:
            def read_text(self, name):
                assert name == "direct_url.json"
                return '{"vcs_info":{"commit_id":"unsupported"}}'

        monkeypatch.setattr(
            launch.importlib.metadata, "distribution", lambda _: Distribution()
        )
    with pytest.raises(ValueError, match="revision"), scrub_before_upload():
        pytest.fail("unsupported revision admitted")
    assert Trial._emit is original


@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
def test_body_exception_restores_binding(error_type):
    original = Trial._emit
    with pytest.raises(error_type), scrub_before_upload() as state:
        raise error_type()
    assert state.failed
    assert Trial._emit is original
    with scrub_before_upload() as next_state:
        assert not next_state.failed


def test_overlapping_context_rejected():
    original = Trial._emit
    with scrub_before_upload():
        patched = Trial._emit
        with (
            pytest.raises(RuntimeError, match="already active"),
            scrub_before_upload(),
        ):
            pytest.fail("nested integration admitted")
        assert Trial._emit is patched
    assert Trial._emit is original


def test_foreign_binding_rejected_and_not_overwritten(monkeypatch):
    foreign = AsyncMock()
    monkeypatch.setattr(Trial, "_emit", foreign)
    with pytest.raises(RuntimeError, match="Unexpected"), scrub_before_upload():
        pytest.fail("foreign binding admitted")
    assert Trial._emit is foreign


def test_rebinding_inside_context_restores_and_vetoes():
    original = Trial._emit
    with (
        pytest.raises(RuntimeError, match="rebound"),
        scrub_before_upload() as state,
    ):
        Trial._emit = AsyncMock()
    assert state.failed
    assert Trial._emit is original
    with scrub_before_upload():
        pass

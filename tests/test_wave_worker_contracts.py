from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import httpx
import pytest
from pydantic import ValidationError
from test_wave_worker import _provider_wave_inputs

import harbor_hf.wave_worker as wave_worker
from harbor_hf.coordination import ClaimConflict
from harbor_hf.evidence import verify_checksums, write_checksums
from harbor_hf.executions import ExecutionLock
from harbor_hf.models import ExperimentSpec, TrialEvidencePolicy
from harbor_hf.runs import RunLock, RunTrialLock, WaveExecutionLock, WaveLock
from harbor_hf.trial_evidence import assemble_trial_evidence
from harbor_hf.wave_worker import (
    AttemptLock,
    LockedSubmitWaveAction,
    WorkerError,
    _cleanup_wave_resources,
    _expected_agent_version,
    _file_digest,
    _job_ingress_base_url,
    _prepare_trial_recovery,
    _prepare_wave_target,
    _publish_digest_sidecar,
    _publish_immutable_file,
    _publish_unit,
    _reject_terminal_wave,
    _remaining_seconds,
    _trial_destination,
    _valid_terminal_trial,
    _validate_attempt_identity,
    _wait_for_judge_recorder,
    _wave_worker_lease,
)

IDENTITY = {
    "run_id": "run-1",
    "wave_id": "wave-1",
    "execution_id": "execution-1",
    "shard_id": "shard-1",
}
NOW = datetime(2026, 7, 14, 1, 2, 3, tzinfo=UTC)


class FakeClaims:
    def __init__(self) -> None:
        self.acquire_calls: list[tuple[str, dict[str, str]]] = []
        self.release_calls: list[tuple[str, dict[str, str]]] = []
        self.conflict = False

    def acquire(self, path: str, owner: Mapping[str, str]) -> None:
        self.acquire_calls.append((path, dict(owner)))
        if self.conflict:
            raise ClaimConflict(f"claim is already held: {path}")

    def release(self, path: str, owner: Mapping[str, str]) -> None:
        self.release_calls.append((path, dict(owner)))


def _expected_trial() -> RunTrialLock:
    return RunTrialLock(
        trial_id="trial-1",
        trial_digest="d" * 64,
        task_name="task-a",
        task_digest="sha256:" + "a" * 64,
        logical_attempt=1,
    )


def _attempt_lock(expected: RunTrialLock, attempt_id: str) -> AttemptLock:
    return AttemptLock(
        attempt_id=attempt_id,
        created_at=datetime(2026, 7, 14, tzinfo=UTC),
        run_id=IDENTITY["run_id"],
        wave_id=IDENTITY["wave_id"],
        execution_id=IDENTITY["execution_id"],
        shard_id=IDENTITY["shard_id"],
        trial_id=expected.trial_id,
        task_name=expected.task_name,
        task_digest=expected.task_digest,
        logical_attempt=expected.logical_attempt,
        physical_attempt=1,
    )


def _trial_evidence_policy() -> TrialEvidencePolicy:
    return TrialEvidencePolicy(
        workspace_root="/app",
        workspace_max_nodes=100,
        workspace_max_file_bytes=1024 * 1024,
        workspace_max_total_bytes=8 * 1024 * 1024,
        workspace_max_archive_bytes=8 * 1024 * 1024,
        workspace_capture_timeout_seconds=60,
        judge_max_request_bytes=1024 * 1024,
        judge_max_response_bytes=1024 * 1024,
        judge_timeout_seconds=300,
        judge_max_calls_per_execution=4,
    )


def _write_trial_evidence(
    execution: Path, expected: RunTrialLock, attempt_id: str
) -> None:
    native = execution / "harbor-jobs" / "job" / expected.task_name
    workspace = native / "artifacts" / "workspace" / "app"
    workspace.mkdir(parents=True)
    (workspace / "answer.txt").write_text("answer\n", encoding="utf-8")
    agent = native / "agent"
    agent.mkdir()
    (agent / "session.jsonl").write_text('{"role":"assistant"}\n', encoding="utf-8")
    (agent / "trajectory.jsonl").write_text('{"event":"done"}\n', encoding="utf-8")
    verifier = native / "verifier"
    verifier.mkdir()
    (verifier / "reward.txt").write_text("1\n", encoding="utf-8")
    (verifier / "scorecard.json").write_text('{"passed":true}\n', encoding="utf-8")
    assemble_trial_evidence(
        native,
        run_id=IDENTITY["run_id"],
        execution_id=IDENTITY["execution_id"],
        attempt_id=attempt_id,
        trial_id=expected.trial_id,
        task_name=expected.task_name,
        task_digest=expected.task_digest,
        logical_attempt=expected.logical_attempt,
        physical_attempt=1,
        judge_expected=False,
        judge_model=None,
        policy=_trial_evidence_policy(),
    )


def _terminal_trial(root: Path) -> tuple[Path, RunTrialLock, Path]:
    expected = _expected_trial()
    trial = root / "trial"
    attempt_id = "exec-" + "0" * 32
    execution = trial / "attempts" / attempt_id
    execution.mkdir(parents=True)
    (execution / "attempt.lock.json").write_text(
        _attempt_lock(expected, attempt_id).model_dump_json(), encoding="utf-8"
    )
    (execution / "harbor.log").write_text("completed\n", encoding="utf-8")
    _write_trial_evidence(execution, expected, attempt_id)
    (execution / "_SUCCESS").write_text("\n", encoding="utf-8")
    write_checksums(execution)
    (trial / "trial.lock.json").write_text(
        json.dumps(expected.model_dump(mode="json")), encoding="utf-8"
    )
    (trial / "trial-summary.json").write_text(
        json.dumps(
            {
                "trial_id": expected.trial_id,
                "attempt_id": attempt_id,
                "attempt_checksum": _file_digest(execution / "checksums.json"),
            }
        ),
        encoding="utf-8",
    )
    (trial / "_SUCCESS").write_text("\n", encoding="utf-8")
    write_checksums(trial)
    return trial, expected, execution


def _rewrite_summary(trial: Path, **updates: object) -> None:
    summary_path = trial / "trial-summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary.update(updates)
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    write_checksums(trial)


def test_valid_terminal_trial_accepts_exact_success_evidence(tmp_path: Path) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    assert _valid_terminal_trial(trial, expected, **IDENTITY) is True


def test_valid_terminal_trial_finishes_interrupted_marker_publication(
    tmp_path: Path,
) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    (trial / "_SUCCESS").unlink()

    assert _valid_terminal_trial(trial, expected, **IDENTITY) is True

    assert (trial / "_SUCCESS").read_text(encoding="utf-8") == "\n"
    verify_checksums(trial)


def test_valid_terminal_trial_returns_false_without_evidence(tmp_path: Path) -> None:
    expected = _expected_trial()
    assert _valid_terminal_trial(tmp_path / "missing", expected, **IDENTITY) is False
    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / "unrelated.txt").write_text("x", encoding="utf-8")
    assert _valid_terminal_trial(empty, expected, **IDENTITY) is False
    marker_dir = tmp_path / "marker-dir"
    (marker_dir / "_SUCCESS").mkdir(parents=True)
    assert _valid_terminal_trial(marker_dir, expected, **IDENTITY) is False


@pytest.mark.parametrize(
    "markers",
    [["_FAILED"], ["_CANCELLED"], ["_SUCCESS", "_FAILED"], ["_SUCCESS", "_CANCELLED"]],
)
def test_valid_terminal_trial_rejects_non_success_markers(
    tmp_path: Path, markers: list[str]
) -> None:
    trial = tmp_path / "trial"
    trial.mkdir()
    for marker in markers:
        (trial / marker).write_text("\n", encoding="utf-8")

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, _expected_trial(), **IDENTITY)
    assert str(captured.value) == "terminal trial evidence is not a valid success"


@pytest.mark.parametrize("field", ["run_id", "wave_id", "execution_id", "shard_id"])
def test_valid_terminal_trial_rejects_each_identity_mismatch(
    tmp_path: Path, field: str
) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    identity = dict(IDENTITY, **{field: "other"})

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **identity)
    assert str(captured.value) == ("terminal attempt identity does not match its trial")


def test_valid_terminal_trial_rejects_mismatched_trial_lock(tmp_path: Path) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    tampered = expected.model_copy(update={"trial_digest": "e" * 64})

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, tampered, **IDENTITY)
    assert str(captured.value) == "terminal trial lock does not match the wave"


def test_valid_terminal_trial_rejects_summary_without_attempt_id(
    tmp_path: Path,
) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    _rewrite_summary(trial, attempt_id=5)

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **IDENTITY)
    assert str(captured.value) == "terminal trial summary has no attempt identity"


def test_valid_terminal_trial_rejects_wrong_summary_trial_id(tmp_path: Path) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    _rewrite_summary(trial, trial_id="trial-wrong")

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **IDENTITY)
    assert str(captured.value) == (
        "terminal trial summary has the wrong trial identity"
    )


def test_valid_terminal_trial_rejects_unsuccessful_attempt(tmp_path: Path) -> None:
    trial, expected, execution = _terminal_trial(tmp_path)
    (execution / "_SUCCESS").unlink()

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **IDENTITY)
    assert str(captured.value) == "terminal trial attempt is not successful"


def test_valid_terminal_trial_rejects_wrong_child_checksum(tmp_path: Path) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    _rewrite_summary(trial, attempt_checksum="sha256:" + "0" * 64)

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **IDENTITY)
    assert str(captured.value) == (
        "terminal trial summary has the wrong child checksum"
    )


def test_valid_terminal_trial_wraps_checksum_corruption(tmp_path: Path) -> None:
    trial, expected, execution = _terminal_trial(tmp_path)
    (execution / "harbor.log").write_text("tampered\n", encoding="utf-8")

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **IDENTITY)
    assert str(captured.value) == "terminal trial evidence failed checksum validation"


def test_valid_terminal_trial_wraps_missing_summary(tmp_path: Path) -> None:
    trial, expected, _execution = _terminal_trial(tmp_path)
    (trial / "trial-summary.json").unlink()

    with pytest.raises(WorkerError) as captured:
        _valid_terminal_trial(trial, expected, **IDENTITY)
    assert str(captured.value) == "terminal trial evidence failed checksum validation"


@pytest.mark.parametrize(
    "field",
    [
        "attempt_id",
        "run_id",
        "wave_id",
        "execution_id",
        "shard_id",
        "trial_id",
        "task_name",
        "task_digest",
        "logical_attempt",
    ],
)
def test_attempt_identity_rejects_each_field_mismatch(field: str) -> None:
    expected = _expected_trial()
    attempt_id = "exec-" + "1" * 32
    lock = _attempt_lock(expected, attempt_id)
    tampered = lock.model_copy(
        update={field: 99 if field == "logical_attempt" else "other"}
    )

    with pytest.raises(WorkerError) as captured:
        _validate_attempt_identity(tampered, attempt_id, expected, **IDENTITY)
    assert str(captured.value) == ("terminal attempt identity does not match its trial")

    _validate_attempt_identity(lock, attempt_id, expected, **IDENTITY)


def test_attempt_identity_ignores_physical_attempt() -> None:
    expected = _expected_trial()
    attempt_id = "exec-" + "1" * 32
    lock = _attempt_lock(expected, attempt_id).model_copy(
        update={"physical_attempt": 7}
    )
    _validate_attempt_identity(lock, attempt_id, expected, **IDENTITY)


def test_publish_immutable_file_copies_exact_bytes_once(tmp_path: Path) -> None:
    source = tmp_path / "source.json"
    source.write_bytes(b"payload")
    destination = tmp_path / "nested" / "deep" / "destination.json"

    _publish_immutable_file(source, destination)
    assert destination.read_bytes() == b"payload"
    assert [path.name for path in destination.parent.iterdir()] == ["destination.json"]

    _publish_immutable_file(source, destination)
    assert destination.read_bytes() == b"payload"

    source.write_bytes(b"different")
    with pytest.raises(WorkerError) as captured:
        _publish_immutable_file(source, destination)
    assert str(captured.value) == (
        f"evidence path already has different contents: {destination}"
    )
    assert destination.read_bytes() == b"payload"
    assert [path.name for path in destination.parent.iterdir()] == ["destination.json"]


def test_publish_immutable_file_avoids_hf_mount_reserved_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    source.write_bytes(b"terminal\n")
    destination = tmp_path / "bucket" / "_SUCCESS"
    original_copyfile = wave_worker.shutil.copyfile
    temporary_names: list[str] = []

    def reject_reserved_prefix(source_path: Path, destination_path: Path) -> Path:
        temporary_names.append(destination_path.name)
        if destination_path.name.startswith("._"):
            raise PermissionError("HF bucket mounts reserve the ._ prefix")
        return original_copyfile(source_path, destination_path)

    monkeypatch.setattr(wave_worker.shutil, "copyfile", reject_reserved_prefix)

    _publish_immutable_file(source, destination)

    assert destination.read_bytes() == b"terminal\n"
    assert len(temporary_names) == 1
    assert temporary_names[0].startswith(".harbor-hf-")
    assert temporary_names[0].endswith("-_SUCCESS.tmp")


def test_wave_worker_lease_serializes_the_complete_remote_job(
    remote_spec: ExperimentSpec, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _spec, _run, wave, *_paths = _provider_wave_inputs(
        remote_spec,
        tmp_path,
        attempts=1,
        concurrency=1,
        provider_concurrency=1,
    )
    claims = FakeClaims()
    monkeypatch.setenv("JOB_ID", "job-one")

    with _wave_worker_lease(wave, "token", claims, lambda: NOW):
        assert len(claims.acquire_calls) == 1
        assert claims.release_calls == []

    assert claims.release_calls == claims.acquire_calls
    path, owner = claims.acquire_calls[0]
    assert path.startswith("wave-worker-leases/")
    assert owner == {
        "run_id": wave.run_id,
        "wave_id": wave.wave_id,
        "job_id": "job-one",
        "expires_at": (
            NOW + timedelta(seconds=wave.remote.job.timeout_seconds)
        ).isoformat(),
    }


def test_wave_worker_lease_fails_closed_without_job_identity(
    remote_spec: ExperimentSpec, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _spec, _run, wave, *_paths = _provider_wave_inputs(
        remote_spec,
        tmp_path,
        attempts=1,
        concurrency=1,
        provider_concurrency=1,
    )
    monkeypatch.delenv("JOB_ID", raising=False)

    with (
        pytest.raises(WorkerError, match="wave worker claim requires JOB_ID"),
        _wave_worker_lease(wave, "token", None, lambda: NOW),
    ):
        raise AssertionError("worker entered without a lease")


def test_wave_worker_lease_rejects_duplicate_job_before_execution(
    remote_spec: ExperimentSpec, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _spec, _run, wave, *_paths = _provider_wave_inputs(
        remote_spec,
        tmp_path,
        attempts=1,
        concurrency=1,
        provider_concurrency=1,
    )
    claims = FakeClaims()
    claims.conflict = True
    monkeypatch.setenv("JOB_ID", "job-two")

    with (
        pytest.raises(WorkerError, match="wave worker is already active"),
        _wave_worker_lease(wave, "token", claims, lambda: NOW),
    ):
        raise AssertionError("duplicate worker entered the lease")

    assert len(claims.acquire_calls) == 1
    assert claims.release_calls == []


def test_publish_digest_sidecar_writes_exact_digest_line(tmp_path: Path) -> None:
    source = tmp_path / "run.lock.json"
    source.write_bytes(b"wave-contract\n")
    destination = tmp_path / "published"

    _publish_digest_sidecar(source, destination)

    sidecar = tmp_path / "run.lock.json.sha256"
    expected = (
        "sha256:8b6a391b539bf23c01dfed62246c6e04cb057e7bd5c119318589b64df6c1b413\n"
    )
    assert sidecar.read_text(encoding="utf-8") == expected
    assert (destination / "run.lock.json.sha256").read_text(
        encoding="utf-8"
    ) == expected


def _finalized_unit(root: Path, marker: str) -> Path:
    source = root / "unit"
    (source / "nested").mkdir(parents=True)
    (source / "top.json").write_text("{}", encoding="utf-8")
    (source / "nested" / "inner.log").write_text("log\n", encoding="utf-8")
    write_checksums(source)
    (source / marker).write_text("\n", encoding="utf-8")
    return source


def test_publish_unit_publishes_all_files_and_marker(tmp_path: Path) -> None:
    source = _finalized_unit(tmp_path, "_SUCCESS")
    destination = tmp_path / "published"

    _publish_unit(source, destination)

    published = sorted(
        str(path.relative_to(destination))
        for path in destination.rglob("*")
        if path.is_file()
    )
    assert published == [
        "_SUCCESS",
        "checksums.json",
        "nested/inner.log",
        "top.json",
    ]
    assert (destination / "_SUCCESS").read_text(encoding="utf-8") == "\n"
    assert (destination / "nested" / "inner.log").read_text(encoding="utf-8") == "log\n"


def test_publish_unit_recovers_interrupted_destination_with_new_contents(
    tmp_path: Path,
) -> None:
    source = _finalized_unit(tmp_path / "retry", "_FAILED")
    (source / "top.json").write_text('{"attempt": 2}\n', encoding="utf-8")
    write_checksums(source)
    destination = tmp_path / "published"
    destination.mkdir()
    (destination / "top.json").write_text('{"attempt": 1}\n', encoding="utf-8")
    (destination / "abandoned.tmp").write_text("partial\n", encoding="utf-8")

    _publish_unit(source, destination)

    assert (destination / "top.json").read_text(encoding="utf-8") == (
        '{"attempt": 2}\n'
    )
    assert not (destination / "abandoned.tmp").exists()
    assert verify_checksums(destination) == verify_checksums(source)
    assert (destination / "_FAILED").is_file()


@pytest.mark.parametrize("marker", ["_SUCCESS", "_FAILED", "_CANCELLED"])
def test_publish_unit_rejects_complete_terminal_destination(
    tmp_path: Path, marker: str
) -> None:
    source = _finalized_unit(tmp_path / "source", "_SUCCESS")
    destination = tmp_path / "published"
    destination.mkdir()
    (destination / marker).write_text("terminal\n", encoding="utf-8")

    with pytest.raises(WorkerError, match="cannot be overwritten"):
        _publish_unit(source, destination)

    assert (destination / marker).read_text(encoding="utf-8") == "terminal\n"


def test_publish_unit_verifies_destination_before_terminal_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _finalized_unit(tmp_path / "source", "_SUCCESS")
    destination = tmp_path / "published"
    original_replace = wave_worker.os.replace

    def corrupt_after_replace(temporary: Path, published: Path) -> None:
        original_replace(temporary, published)
        if published == destination / "top.json":
            published.write_text("corrupted\n", encoding="utf-8")

    monkeypatch.setattr(wave_worker.os, "replace", corrupt_after_replace)

    with pytest.raises(RuntimeError, match="checksum mismatch"):
        _publish_unit(source, destination)

    assert not (destination / "_SUCCESS").exists()


def _finalized_execution(root: Path, attempt_id: str, marker: str) -> Path:
    execution = root / "attempts" / attempt_id
    execution.mkdir(parents=True)
    (execution / "events.jsonl").write_text(
        f'{{"attempt_id": "{attempt_id}"}}\n', encoding="utf-8"
    )
    write_checksums(execution)
    (execution / marker).write_text("\n", encoding="utf-8")
    return execution


def test_publish_unit_recovers_trial_around_immutable_terminal_executions(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source-trial"
    prior_source = _finalized_execution(source, "exec-prior", "_FAILED")
    _finalized_execution(source, "exec-new", "_SUCCESS")
    (source / "trial-summary.json").write_text(
        '{"attempt_id": "exec-new"}\n', encoding="utf-8"
    )
    write_checksums(source)
    (source / "_SUCCESS").write_text("\n", encoding="utf-8")

    destination = tmp_path / "published-trial"
    prior_destination = _finalized_execution(destination, "exec-prior", "_FAILED")
    abandoned = destination / "attempts" / "exec-abandoned"
    abandoned.mkdir()
    (abandoned / "events.jsonl").write_text("partial\n", encoding="utf-8")
    (destination / "trial-summary.json").write_text(
        '{"attempt_id": "exec-old"}\n', encoding="utf-8"
    )
    prior_checksum = _file_digest(prior_destination / "events.jsonl")

    _publish_unit(source, destination)

    assert not abandoned.exists()
    assert _file_digest(prior_destination / "events.jsonl") == prior_checksum
    assert _trees_equal(prior_source, prior_destination)
    assert (destination / "attempts" / "exec-new" / "_SUCCESS").is_file()
    assert (destination / "_SUCCESS").is_file()
    verify_checksums(destination)


def test_publish_unit_rejects_changed_terminal_nested_execution(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source-trial"
    source_attempt = _finalized_execution(source, "exec-prior", "_FAILED")
    (source_attempt / "events.jsonl").write_text("new\n", encoding="utf-8")
    write_checksums(source_attempt)
    write_checksums(source)
    (source / "_SUCCESS").write_text("\n", encoding="utf-8")
    destination = tmp_path / "published-trial"
    _finalized_execution(destination, "exec-prior", "_FAILED")

    with pytest.raises(WorkerError, match="cannot be overwritten"):
        _publish_unit(source, destination)

    assert not (destination / "_SUCCESS").exists()


def _trees_equal(first: Path, second: Path) -> bool:
    first_files = {
        path.relative_to(first): path.read_bytes()
        for path in first.rglob("*")
        if path.is_file()
    }
    second_files = {
        path.relative_to(second): path.read_bytes()
        for path in second.rglob("*")
        if path.is_file()
    }
    return first_files == second_files


def test_publish_unit_requires_exactly_one_marker(tmp_path: Path) -> None:
    unmarked = tmp_path / "unmarked"
    unmarked.mkdir()
    write_checksums(unmarked)
    with pytest.raises(WorkerError) as captured:
        _publish_unit(unmarked, tmp_path / "out-a")
    assert str(captured.value) == (
        "finalized wave evidence must have one terminal marker"
    )

    double = _finalized_unit(tmp_path, "_SUCCESS")
    (double / "_FAILED").write_text("\n", encoding="utf-8")
    with pytest.raises(WorkerError) as captured:
        _publish_unit(double, tmp_path / "out-b")
    assert str(captured.value) == (
        "finalized wave evidence must have one terminal marker"
    )


def test_publish_unit_rejects_corrupted_source(tmp_path: Path) -> None:
    source = _finalized_unit(tmp_path, "_FAILED")
    (source / "top.json").write_text('{"tampered": true}', encoding="utf-8")

    with pytest.raises(RuntimeError, match="checksum mismatch"):
        _publish_unit(source, tmp_path / "published")
    assert not (tmp_path / "published" / "_FAILED").exists()


@pytest.mark.parametrize("marker", ["_SUCCESS", "_FAILED", "_CANCELLED"])
def test_reject_terminal_wave_raises_for_each_marker(
    tmp_path: Path, marker: str
) -> None:
    destination = tmp_path / "wave"
    destination.mkdir()
    (destination / marker).write_text("\n", encoding="utf-8")

    with pytest.raises(WorkerError) as captured:
        _reject_terminal_wave(destination)
    assert str(captured.value) == "deployment wave already has terminal evidence"


def test_reject_terminal_wave_allows_fresh_destinations(tmp_path: Path) -> None:
    _reject_terminal_wave(tmp_path / "missing")
    partial = tmp_path / "partial"
    (partial / "_SUCCESS").mkdir(parents=True)
    (partial / "events.jsonl").write_text("", encoding="utf-8")
    _reject_terminal_wave(partial)


@pytest.mark.parametrize("marker", ["_SUCCESS", "_FAILED", "_CANCELLED"])
def test_prepare_trial_recovery_refuses_terminal_destination(
    tmp_path: Path, marker: str
) -> None:
    destination = tmp_path / "destination"
    destination.mkdir()
    (destination / marker).write_text("\n", encoding="utf-8")

    with pytest.raises(WorkerError) as captured:
        _prepare_trial_recovery(destination, tmp_path / "trial")
    assert str(captured.value) == "terminal trial evidence cannot be overwritten"
    assert not (tmp_path / "trial").exists()


def test_prepare_trial_recovery_copies_terminal_prior_executions(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "destination"
    attempts = destination / "attempts" / "exec-prior"
    attempts.mkdir(parents=True)
    (attempts / "harbor.log").write_text("prior\n", encoding="utf-8")
    write_checksums(attempts)
    (attempts / "_FAILED").write_text("{}\n", encoding="utf-8")
    trial_root = tmp_path / "trial"

    _prepare_trial_recovery(destination, trial_root)

    assert (trial_root / "attempts" / "exec-prior" / "harbor.log").read_text(
        encoding="utf-8"
    ) == "prior\n"


def test_prepare_trial_recovery_removes_interrupted_execution(tmp_path: Path) -> None:
    execution = tmp_path / "destination" / "attempts" / "exec-abandoned"
    execution.mkdir(parents=True)
    (execution / "events.jsonl").write_text("partial\n", encoding="utf-8")
    trial_root = tmp_path / "trial"

    _prepare_trial_recovery(tmp_path / "destination", trial_root)

    assert not execution.exists()
    assert list((trial_root / "attempts").iterdir()) == []


def test_prepare_trial_recovery_rejects_corrupt_terminal_execution(
    tmp_path: Path,
) -> None:
    execution = tmp_path / "destination" / "attempts" / "exec-corrupt"
    execution.mkdir(parents=True)
    (execution / "events.jsonl").write_text("original\n", encoding="utf-8")
    write_checksums(execution)
    (execution / "_SUCCESS").write_text("\n", encoding="utf-8")
    (execution / "events.jsonl").write_text("tampered\n", encoding="utf-8")

    with pytest.raises(WorkerError, match="failed checksum validation"):
        _prepare_trial_recovery(tmp_path / "destination", tmp_path / "trial")


def test_prepare_trial_recovery_creates_empty_trial_root(tmp_path: Path) -> None:
    trial_root = tmp_path / "trial"
    _prepare_trial_recovery(tmp_path / "missing", trial_root)

    assert trial_root.is_dir()
    assert list(trial_root.iterdir()) == []


def test_trial_destination_builds_exact_path(tmp_path: Path) -> None:
    run = cast(RunLock, SimpleNamespace(artifact_prefix="runs/r1"))
    execution = cast(
        WaveExecutionLock,
        SimpleNamespace(configuration=SimpleNamespace(execution_id="execution-9")),
    )
    trial = cast(RunTrialLock, SimpleNamespace(trial_id="trial-9"))

    assert _trial_destination(tmp_path, run, execution, trial) == (
        tmp_path / "runs/r1" / "executions" / "execution-9" / "trials" / "trial-9"
    )


def test_expected_agent_version_uses_locked_revision_kind() -> None:
    package = cast(
        ExecutionLock,
        SimpleNamespace(
            agent=SimpleNamespace(
                revision_kind="package",
                revision="2026.7.2",
                reported_version=None,
            )
        ),
    )
    assert _expected_agent_version(package) == "2026.7.2"

    source = cast(
        ExecutionLock,
        SimpleNamespace(
            agent=SimpleNamespace(
                revision_kind="harbor-source",
                revision="a" * 40,
                reported_version="2026.7.9",
            )
        ),
    )
    assert _expected_agent_version(source) == "2026.7.9"


def test_remaining_seconds_rounds_up_and_enforces_floor() -> None:
    assert _remaining_seconds(10.0, lambda: 7.5) == 3
    assert _remaining_seconds(10.0, lambda: 7.0) == 3
    assert _remaining_seconds(3601.0, lambda: 0.0) == 3601
    with pytest.raises(WorkerError) as captured:
        _remaining_seconds(10.0, lambda: 10.5)
    assert str(captured.value) == "deployment wave duration bound was reached"


def test_attempt_lock_schema_and_action_defaults() -> None:
    expected = _expected_trial()
    lock = _attempt_lock(expected, "exec-" + "2" * 32)
    assert lock.schema_version == "harbor-hf/attempt-lock/v1alpha1"

    action = LockedSubmitWaveAction(
        action_id="action-1",
        action_key="key-1",
        run_id="run-1",
        deployment_digest="digest-1",
        shard_ids=["shard-1"],
    )
    assert action.kind == "submit-wave"
    with pytest.raises(ValidationError):
        LockedSubmitWaveAction.model_validate(
            {
                "action_id": "action-1",
                "action_key": "key-1",
                "run_id": "run-1",
                "deployment_digest": "digest-1",
                "shard_ids": ["shard-1"],
                "unexpected": "extra",
            }
        )


def test_provider_target_resolves_direct_upstream_without_cleanup(
    remote_spec: ExperimentSpec, tmp_path: Path
) -> None:
    _spec, _run, wave, *_paths = _provider_wave_inputs(
        remote_spec,
        tmp_path,
        attempts=1,
        concurrency=1,
        provider_concurrency=1,
    )
    events = tmp_path / "events.jsonl"
    target = wave.provider_target
    assert target is not None

    base_url = _prepare_wave_target(
        wave,
        tmp_path,
        events,
        None,
        100.0,
        lambda: 0.0,
    )

    assert base_url == "https://router.huggingface.co"
    assert _cleanup_wave_resources(None) is None
    runtime = json.loads((tmp_path / "runtime-environment.json").read_text())
    assert runtime["provider"]["upstream"] == base_url
    assert runtime["provider"]["scheduling"] == {"max_concurrent_shards": 1}


def test_judge_recorder_base_url_validates_job_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JOB_ID", "0123456789abcdef01234567")
    assert _job_ingress_base_url(8001, "judge recorder") == (
        "https://0123456789abcdef01234567--8001.hf.jobs"
    )

    for invalid in ("", "UPPERCASE", "bad.id", "-leading", "trailing-"):
        monkeypatch.setenv("JOB_ID", invalid)
        with pytest.raises(WorkerError, match="requires a valid HF JOB_ID"):
            _job_ingress_base_url(8001, "judge recorder")


def test_judge_recorder_readiness_retries() -> None:
    attempts: list[httpx.Request] = []

    def ingress(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        assert request.headers["authorization"] == "Bearer test-token"
        if len(attempts) == 1:
            return httpx.Response(503, json={"error": "starting"})
        return httpx.Response(200, json={"status": "ok"})

    now = [0.0]
    client = httpx.Client(transport=httpx.MockTransport(ingress))
    try:
        _wait_for_judge_recorder(
            "https://job--8001.hf.jobs",
            "test-token",
            10.0,
            lambda: now[0],
            sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
            client=client,
        )
    finally:
        client.close()

    assert len(attempts) == 2
    assert attempts[0].url == "https://job--8001.hf.jobs/healthz"
    assert now[0] == 1.0


def test_judge_recorder_readiness_fails_closed() -> None:
    unauthorized = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(401, json={"error": "unauthorized"})
        )
    )
    try:
        with pytest.raises(WorkerError, match="rejected HF authentication"):
            _wait_for_judge_recorder(
                "https://job--8001.hf.jobs",
                "test-token",
                10.0,
                lambda: 0.0,
                sleep=lambda _seconds: None,
                client=unauthorized,
            )
    finally:
        unauthorized.close()

    now = [0.0]

    def unavailable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unavailable", request=request)

    disconnected = httpx.Client(transport=httpx.MockTransport(unavailable))
    try:
        with pytest.raises(WorkerError, match="readiness timed out: ConnectError"):
            _wait_for_judge_recorder(
                "https://job--8001.hf.jobs",
                "test-token",
                2.0,
                lambda: now[0],
                sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
                client=disconnected,
            )
    finally:
        disconnected.close()


def test_endpoint_transport_delegates_prepare_and_cleanup() -> None:
    calls: list[tuple[object, ...]] = []

    class Lifecycle:
        def prepare(self, deadline: float, monotonic: Callable[[], float]) -> str:
            calls.append(("prepare", deadline, monotonic()))
            return "https://endpoint.example"

        def cleanup(self) -> Exception | None:
            calls.append(("cleanup",))
            return RuntimeError("cleanup failed")

    lifecycle = cast(wave_worker._EndpointWaveLifecycle, Lifecycle())
    base_url = _prepare_wave_target(
        cast(WaveLock, None),
        cast(Path, None),
        cast(Path, None),
        lifecycle,
        50.0,
        lambda: 2.0,
    )

    assert base_url == "https://endpoint.example"
    assert str(_cleanup_wave_resources(lifecycle)) == "cleanup failed"
    assert calls == [("prepare", 50.0, 2.0), ("cleanup",)]

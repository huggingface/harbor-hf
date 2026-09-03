from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

import pytest
from test_wave_worker import _provider_wave_inputs, _wave_inputs

import harbor_hf.wave_worker as wave_worker
import harbor_hf.worker as worker
from harbor_hf.benchmark_source import source_lock_from_spec
from harbor_hf.executions import ExecutionLock, build_execution_lock
from harbor_hf.models import DeploymentProfile, EndpointRef, ExperimentSpec, SourcePin
from harbor_hf.process import CommandRunner
from harbor_hf.wave_worker import _EndpointWaveLifecycle
from harbor_hf.worker import WorkerError, _prepare_evidence_destination


def _events(path: Path) -> list[dict[str, object]]:
    return [
        {key: value for key, value in json.loads(line).items() if key != "at"}
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


class _UnusedRunner:
    def run_json(
        self,
        command: Sequence[str],
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, object]:
        raise AssertionError((command, timeout_seconds))

    def run_text(
        self,
        command: Sequence[str],
        *,
        timeout_seconds: float | None = None,
    ) -> str:
        raise AssertionError((command, timeout_seconds))


def test_staged_worker_success_has_exact_ordered_side_effects(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = build_execution_lock(remote_spec, execution_id="staged-worker-contract")
    source_lock = source_lock_from_spec(remote_spec)
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text("manifest-contract\n", encoding="utf-8")
    root = tmp_path / "staging" / "run"
    destination = tmp_path / "published" / "run"
    _prepare_evidence_destination(destination)
    runner = _UnusedRunner()
    calls: list[tuple[object, ...]] = []
    baseline: dict[str, object] = {"snapshot": "baseline"}
    final: dict[str, object] = {
        "status": {
            "state": "paused",
            "readyReplica": 0,
            "targetReplica": 1,
        },
        "apiToken": "must-redact",
    }

    class Manager:
        def __init__(
            self, namespace: str, name: str, process_runner: CommandRunner
        ) -> None:
            calls.append(("manager", namespace, name, process_runner))

        def describe(self) -> dict[str, object]:
            calls.append(("describe",))
            return baseline

        def pause_and_verify(self) -> dict[str, object]:
            calls.append(("pause_and_verify",))
            return final

    monkeypatch.setattr(worker, "EndpointManager", Manager)
    monkeypatch.setattr(
        worker, "require_executable", lambda name: calls.append(("require", name))
    )
    monkeypatch.setattr(
        worker,
        "validate_endpoint_model",
        lambda candidate, snapshot: calls.append(("validate", candidate, snapshot)),
    )
    monkeypatch.setattr(
        worker,
        "require_paused_endpoint",
        lambda snapshot: calls.append(("require_paused", snapshot)),
    )
    monkeypatch.setattr(
        worker,
        "_execute_benchmark",
        lambda *args: calls.append(("execute", *args)),
    )
    monkeypatch.setattr(
        worker,
        "_finalize_evidence",
        lambda candidate, token, **options: calls.append(
            ("finalize", candidate, token, options)
        ),
    )

    def prepare(
        source: SourcePin, destination_path: Path, process_runner: CommandRunner
    ) -> None:
        calls.append(("source", source, destination_path, process_runner))

    def launch(candidate: ExecutionLock, endpoint: EndpointRef, token: str) -> str:
        calls.append(("watchdog", candidate, endpoint, token))
        return "watchdog-contract"

    result = worker._run_staged_worker(
        manifest,
        source_lock,
        lock,
        root,
        destination,
        "contract-token",
        runner=runner,
        stream_runner=lambda *args, **kwargs: 0,
        source_preparer=prepare,
        watchdog_launcher=launch,
        mounted_bundle_root=tmp_path / "unused-bundle",
    )

    assert isinstance(lock.deployment, DeploymentProfile)
    endpoint = lock.deployment.endpoint
    assert endpoint is not None
    harbor_source = (
        root.parent / "sources" / (f"harbor-{lock.remote.harbor.source.revision}")
    )
    assert result == destination
    assert calls[:7] == [
        ("manager", endpoint.namespace, endpoint.name, runner),
        ("require", "git"),
        ("source", lock.remote.harbor.source, harbor_source, runner),
        ("describe",),
        ("validate", lock, baseline),
        ("require_paused", baseline),
        ("watchdog", lock, endpoint, "contract-token"),
    ]
    assert calls[7][0] == "execute"
    assert calls[7][1:6] == (
        root,
        root / "events.jsonl",
        lock,
        calls[7][4],
        "contract-token",
    )
    assert calls[8:] == [
        ("pause_and_verify",),
        ("finalize", root, "contract-token", {"strict_compatibility": True}),
    ]
    assert (root / "harbor-jobs").is_dir()
    assert (root / "manifest.yaml").read_text(encoding="utf-8") == (
        "manifest-contract\n"
    )
    assert json.loads((root / "execution.lock.json").read_text(encoding="utf-8")) == (
        lock.model_dump(mode="json")
    )
    assert json.loads((root / "endpoint.final.json").read_text(encoding="utf-8")) == {
        "apiToken": "[REDACTED]",
        "status": final["status"],
    }
    assert _events(destination / "events.jsonl") == [
        {"event": "worker_started", "execution_id": lock.execution_id},
        {"event": "endpoint_baseline_validated"},
        {
            "event": "endpoint_lease_acquired",
            "watchdog_job_id": "watchdog-contract",
        },
        {"event": "cleanup_watchdog_started", "job_id": "watchdog-contract"},
        {"event": "endpoint_pause_requested"},
        {
            "event": "endpoint_paused",
            "state": "paused",
            "ready_replicas": 0,
            "target_replicas": 1,
        },
        {"event": "execution_succeeded"},
    ]
    assert (destination / "_SUCCESS").read_text(encoding="utf-8") == "\n"
    assert not (destination / "_RESERVED").exists()


def test_staged_worker_failure_before_lease_skips_cleanup_and_redacts_publication(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = build_execution_lock(remote_spec, execution_id="staged-worker-failure")
    source_lock = source_lock_from_spec(remote_spec)
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text("manifest\n", encoding="utf-8")
    root = tmp_path / "stage" / "run"
    destination = tmp_path / "output" / "run"
    _prepare_evidence_destination(destination)
    finalized: list[tuple[Path, str]] = []

    class Manager:
        def __init__(self, *args: object) -> None:
            pass

        def pause_and_verify(self) -> dict[str, object]:
            raise AssertionError("cleanup is forbidden before watchdog ownership")

    monkeypatch.setattr(worker, "EndpointManager", Manager)
    monkeypatch.setattr(
        worker,
        "require_executable",
        lambda name: (_ for _ in ()).throw(ValueError("bad contract-token")),
    )
    monkeypatch.setattr(
        worker,
        "_finalize_evidence",
        lambda candidate, token, **_options: finalized.append((candidate, token)),
    )

    with pytest.raises(WorkerError) as captured:
        worker._run_staged_worker(
            manifest,
            source_lock,
            lock,
            root,
            destination,
            "contract-token",
            runner=_UnusedRunner(),
            stream_runner=lambda *args, **kwargs: 0,
            source_preparer=None,
            watchdog_launcher=None,
            mounted_bundle_root=tmp_path / "unused-bundle",
        )

    assert str(captured.value) == "bad [REDACTED]"
    assert isinstance(captured.value.__cause__, ValueError)
    assert finalized == [(root, "contract-token")]
    assert _events(destination / "events.jsonl") == [
        {"event": "worker_started", "execution_id": lock.execution_id},
        {"event": "endpoint_cleanup_skipped", "reason": "lease_not_owned"},
        {"event": "execution_failed", "error_type": "ValueError"},
    ]
    assert json.loads((destination / "_FAILED").read_text(encoding="utf-8")) == {
        "error_type": "ValueError",
        "message": "bad [REDACTED]",
    }
    assert not (destination / "_SUCCESS").exists()


def test_staged_provider_wave_finalizes_then_publishes_exact_success(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _spec, run, wave, manifest, _run_path, _wave_path = _provider_wave_inputs(
        remote_spec,
        tmp_path,
        attempts=1,
        concurrency=1,
        provider_concurrency=1,
    )
    monkeypatch.setenv("HF_INFERENCE_TOKEN", "inference-token")
    run_root = tmp_path / "stage" / run.artifact_prefix
    output_root = tmp_path / "output"
    calls: list[tuple[object, ...]] = []
    shard_kwargs: dict[str, object] = {}
    checksums = {"shard-z": "sha256:z", "shard-a": "sha256:a"}

    monkeypatch.setattr(
        wave_worker,
        "require_executable",
        lambda name: calls.append(("require", name)),
    )

    def prepare_target(*args: object) -> str:
        calls.append(("target", *args))
        return "https://router.huggingface.co"

    def execute_shards(*args: object, **kwargs: object) -> dict[str, str]:
        calls.append(("shards", *args))
        shard_kwargs.update(kwargs)
        return checksums

    def cleanup(lifecycle: object, judge_recorder: object) -> None:
        calls.append(("cleanup", lifecycle, judge_recorder))
        return None

    def finalize(root: Path, token: str) -> None:
        calls.append(("finalize", root, token, (root / "_SUCCESS").exists()))
        assert (root / "wave-summary.json").is_file()

    def publish(source: Path, destination: Path) -> None:
        calls.append(("publish", source, destination, (source / "_SUCCESS").is_file()))

    monkeypatch.setattr(wave_worker, "_prepare_wave_target", prepare_target)
    monkeypatch.setattr(
        wave_worker, "_prepare_judge_transport", lambda *args: (None, None)
    )
    monkeypatch.setattr(wave_worker, "_execute_shards", execute_shards)
    monkeypatch.setattr(wave_worker, "_cleanup_wave_resources", cleanup)
    monkeypatch.setattr(wave_worker, "_finalize_unit", finalize)
    monkeypatch.setattr(wave_worker, "_publish_unit", publish)

    def source_preparer(
        source: SourcePin, destination: Path, runner: CommandRunner
    ) -> None:
        calls.append(("source", source, destination, runner))

    result = wave_worker._run_staged_wave(
        manifest,
        run,
        wave,
        run_root,
        output_root,
        "contract-token",
        _UnusedRunner(),
        lambda *args, **kwargs: 0,
        source_preparer,
        None,
        lambda: "0" * 32,
        lambda: wave.created_at,
        lambda: 100.0,
    )

    wave_root = run_root / "waves" / wave.wave_id
    assert result == output_root / wave.artifact_prefix
    assert [call[0] for call in calls] == [
        "require",
        "source",
        "target",
        "shards",
        "cleanup",
        "finalize",
        "publish",
    ]
    assert calls[0] == ("require", "git")
    assert calls[1][1] == wave.remote.harbor.source
    assert calls[1][2] == (
        run_root.parent / "sources" / f"harbor-{wave.remote.harbor.source.revision}"
    )
    assert calls[4] == ("cleanup", None, None)
    assert shard_kwargs == {
        "judge_recorder": None,
        "judge_base_url": None,
    }
    assert calls[5] == (
        "finalize",
        wave_root,
        ("contract-token", "inference-token"),
        False,
    )
    assert calls[6] == (
        "publish",
        wave_root,
        output_root / wave.artifact_prefix,
        True,
    )
    assert _events(wave_root / "events.jsonl") == [
        {"event": "wave_started", "wave_id": wave.wave_id},
        {"event": "wave_succeeded"},
    ]
    assert json.loads((wave_root / "wave-summary.json").read_text()) == {
        "wave_id": wave.wave_id,
        "run_id": run.run_id,
        "shard_checksums": checksums,
        "endpoint_cleanup_verified": None,
    }
    assert (wave_root / "_SUCCESS").read_text(encoding="utf-8") == "\n"
    assert not (wave_root / "_FAILED").exists()


def test_staged_endpoint_wave_preserves_primary_and_cleanup_failures(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _spec, run, wave, manifest, _run_path, _wave_path = _wave_inputs(
        remote_spec, tmp_path, attempts=1, concurrency=1
    )
    run_root = tmp_path / "stage" / run.artifact_prefix
    output_root = tmp_path / "output"
    calls: list[tuple[object, ...]] = []

    class Lifecycle:
        owned = True

        def cleanup(self) -> Exception:
            calls.append(("cleanup",))
            return RuntimeError("cleanup contract-token")

    lifecycle = Lifecycle()
    monkeypatch.setattr(
        wave_worker,
        "_EndpointWaveLifecycle",
        lambda *args: lifecycle,
    )
    monkeypatch.setattr(wave_worker, "require_executable", lambda name: None)
    monkeypatch.setattr(
        wave_worker,
        "_prepare_wave_target",
        lambda *args: (_ for _ in ()).throw(ValueError("primary contract-token")),
    )
    monkeypatch.setattr(
        wave_worker,
        "_finalize_unit",
        lambda root, token: calls.append(("finalize", root, token)),
    )
    monkeypatch.setattr(
        wave_worker,
        "_publish_unit",
        lambda source, destination: calls.append(("publish", source, destination)),
    )

    with pytest.raises(WorkerError) as captured:
        wave_worker._run_staged_wave(
            manifest,
            run,
            wave,
            run_root,
            output_root,
            "contract-token",
            _UnusedRunner(),
            lambda *args, **kwargs: 0,
            lambda source, destination, runner: None,
            None,
            lambda: "0" * 32,
            lambda: wave.created_at,
            lambda: 100.0,
        )

    wave_root = run_root / "waves" / wave.wave_id
    assert str(captured.value) == (
        "primary [REDACTED]; endpoint cleanup failed: cleanup [REDACTED]"
    )
    assert isinstance(captured.value.__cause__, ValueError)
    assert calls == [
        ("cleanup",),
        ("finalize", wave_root, "contract-token"),
        ("publish", wave_root, output_root / wave.artifact_prefix),
    ]
    summary = {
        "wave_id": wave.wave_id,
        "run_id": run.run_id,
        "shard_checksums": {},
        "endpoint_cleanup_verified": False,
        "error_type": "ValueError",
        "message": "primary [REDACTED]",
        "cleanup_error": {
            "error_type": "RuntimeError",
            "message": "cleanup [REDACTED]",
        },
    }
    assert json.loads((wave_root / "wave-summary.json").read_text()) == summary
    assert json.loads((wave_root / "_FAILED").read_text()) == summary
    assert _events(wave_root / "events.jsonl") == [
        {"event": "wave_started", "wave_id": wave.wave_id},
        {"event": "wave_failed", "error_type": "ValueError"},
    ]
    assert not (wave_root / "_SUCCESS").exists()


def test_endpoint_wave_prepare_validates_every_run_before_lease_and_resume(
    remote_spec: ExperimentSpec,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _spec, _run, wave, _manifest, _run_path, _wave_path = _wave_inputs(
        remote_spec, tmp_path, attempts=2, concurrency=1
    )
    wave_root = tmp_path / "wave"
    wave_root.mkdir()
    events = wave_root / "events.jsonl"
    calls: list[tuple[object, ...]] = []
    baseline: dict[str, object] = {"baseline": True}

    class Manager:
        def describe(self) -> dict[str, object]:
            calls.append(("describe",))
            return baseline

    def launch(lock: object, endpoint: object, token: str) -> str:
        calls.append(("launch", lock, endpoint, token))
        return "watchdog-wave"

    lifecycle = _EndpointWaveLifecycle(
        wave,
        wave_root,
        events,
        _UnusedRunner(),
        "contract-token",
        launch,
    )
    lifecycle.manager = cast(Any, Manager())
    monkeypatch.setattr(
        wave_worker,
        "validate_endpoint_model",
        lambda run, snapshot: calls.append(("validate", run, snapshot)),
    )
    monkeypatch.setattr(
        wave_worker,
        "require_paused_endpoint",
        lambda snapshot: calls.append(("paused", snapshot)),
    )

    def resume(
        root: Path,
        event_path: Path,
        run: ExecutionLock,
        manager: object,
        token: str,
        *,
        readiness_timeout_seconds: int,
        compatible_locks: Sequence[ExecutionLock],
    ) -> str:
        calls.append(
            (
                "resume",
                root,
                event_path,
                run,
                manager,
                token,
                readiness_timeout_seconds,
                compatible_locks,
            )
        )
        return "https://endpoint.example"

    monkeypatch.setattr(wave_worker, "resume_and_probe_endpoint", resume)

    assert lifecycle.prepare(1010.2, lambda: 1000.0) == ("https://endpoint.example")

    assert lifecycle.owned is True
    assert calls == [
        ("describe",),
        *[("validate", run.configuration, baseline) for run in wave.executions],
        ("paused", baseline),
        ("launch", wave, lifecycle.endpoint, "contract-token"),
        (
            "resume",
            wave_root,
            events,
            wave.executions[0].configuration,
            lifecycle.manager,
            "contract-token",
            11,
            tuple(run.configuration for run in wave.executions[1:]),
        ),
    ]
    assert _events(events) == [
        {"event": "endpoint_baseline_validated"},
        {
            "event": "endpoint_lease_acquired",
            "watchdog_job_id": "watchdog-wave",
        },
        {"event": "cleanup_watchdog_started", "job_id": "watchdog-wave"},
    ]

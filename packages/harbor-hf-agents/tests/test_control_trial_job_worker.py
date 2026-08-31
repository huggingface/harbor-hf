from __future__ import annotations

import base64
import json
import logging
import os
import sys
from pathlib import Path

import pytest

from harbor_hf_agents.support import control_trial_job_worker as worker

DIGEST = f"sha256:{'a' * 64}"
TASK_IMAGE = f"example.invalid/task@{DIGEST}"
DECLARED_TASK_IMAGE = "example.invalid/task:release"
WORKER_IMAGE = f"example.invalid/worker@sha256:{'b' * 64}"
MIRROR_REPOSITORY = "mirror.example/harbor-hf/tasks"


def _trial_lock() -> dict:
    return {
        "schema_version": 2,
        "task": {
            "name": "task-a",
            "type": "git",
            "digest": DIGEST,
            "path": "tasks/task-a",
            "git_url": "https://github.com/example/benchmark.git",
            "git_commit_id": "b" * 40,
        },
        "install_only": False,
        "timeout_multiplier": 1.0,
        "agent": {
            "import_path": "example.agent:Agent",
            "model_name": "openai/example/model:together",
            "kwargs": {},
        },
        "skills": [],
        "environment": {
            "import_path": (
                "harbor_hf_agents.support.control_job_environment:ControlJobEnvironment"
            ),
            "delete": True,
            "kwargs": {
                "control_max_command_seconds": 900,
                "control_max_transfer_bytes": 1024 * 1024 * 1024,
                "control_max_transfer_file_bytes": 512 * 1024 * 1024,
                "control_max_transfer_files": 10_000,
                "control_max_transfer_path_depth": 32,
                "control_max_image_bytes": 20 * 1024 * 1024 * 1024,
                "control_max_image_entries": 500_000,
                "control_declared_task_image": DECLARED_TASK_IMAGE,
                "control_task_image": TASK_IMAGE,
            },
        },
        "verifier": {"disable": False},
    }


def _lock() -> dict:
    return {
        "run_id": "run-1",
        "tasks": [
            {
                "task_id": "task-a-trial-1",
                "source_task_id": "task-a",
                "trial_index": 1,
                "input_digest": DIGEST,
            }
        ],
        "profiles": [
            {
                "kind": "deployment",
                "spec": {
                    "route": "hf_job",
                    "preparation": "required",
                    "job_image": WORKER_IMAGE,
                    "harbor_version": "0.22.0",
                    "worker_revision": "abcdef0",
                    "input_price_microusd_per_million_tokens": 100_000,
                    "output_price_microusd_per_million_tokens": 200_000,
                },
            }
        ],
    }


def _prepared_records(lock: dict) -> tuple[dict, dict]:
    run_lock_digest = worker.digest_bytes(worker._canonical_json(lock))
    trial_lock = _trial_lock()
    trial = {
        "schema_version": "v1",
        "kind": "prepared.trial",
        "record_id": "prepared-task-a",
        "created_at": "2026-08-24T00:00:00Z",
        "actor": {"subject": "harbor-hf-control", "role": "service"},
        "run_id": "run-1",
        "preparation_id": "action-prepare",
        "run_lock_digest": run_lock_digest,
        "task_id": "task-a-trial-1",
        "source_task_id": "task-a",
        "trial_index": 1,
        "input_digest": DIGEST,
        "declared_image": DECLARED_TASK_IMAGE,
        "image": TASK_IMAGE,
        "agent_timeout_seconds": 900,
        "verifier_timeout_seconds": 600,
        "environment_build_timeout_seconds": 600,
        "agent_setup_timeout_seconds": 360,
        "trial_lock": trial_lock,
        "trial_lock_digest": worker.digest_json(trial_lock),
    }
    job_lock_header = {
        "schema_version": 2,
        "harbor": {"version": "0.22.0"},
    }
    job = {
        "schema_version": "v1",
        "kind": "prepared.job",
        "record_id": "prepared-job-run-1",
        "created_at": "2026-08-24T00:00:00Z",
        "actor": {"subject": "harbor-hf-control", "role": "service"},
        "run_id": "run-1",
        "preparation_id": "action-prepare",
        "run_lock_digest": run_lock_digest,
        "harbor_version": "0.22.0",
        "job_config": {
            "job_name": "prepared",
            "jobs_dir": "/tmp/jobs",
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "retry": {"max_retries": 0},
            "agents": [
                {
                    "import_path": "example.agent:Agent",
                    "model_name": "openai/example/model:together",
                }
            ],
        },
        "job_lock_header": job_lock_header,
        "trials": [
            {
                "task_id": "task-a-trial-1",
                "record_id": "prepared-task-a",
                "record_digest": worker.digest_bytes(worker._canonical_json(trial)),
            }
        ],
        "harbor_lock_digest": worker.digest_bytes(
            worker._canonical_json(
                {
                    **job_lock_header,
                    "trials": [trial_lock],
                }
            )
        ),
    }
    return job, trial


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    lock = _lock()
    prepared_job, prepared_trial = _prepared_records(lock)
    monkeypatch.setenv("HARBOR_HF_RUN_ID", "run-1")
    monkeypatch.setenv("HARBOR_HF_ACTION_ID", "action-1")
    monkeypatch.setenv("HARBOR_HF_TASK_IDS_JSON", '["task-a-trial-1"]')
    monkeypatch.setenv(
        "HARBOR_HF_RUN_LOCK_DIGEST",
        worker.digest_bytes(worker._canonical_json(lock)),
    )
    monkeypatch.setenv(
        "HARBOR_HF_PREPARED_JOB_DIGEST",
        worker.digest_bytes(worker._canonical_json(prepared_job)),
    )
    monkeypatch.setenv("HARBOR_HF_JOB_IMAGE", WORKER_IMAGE)
    monkeypatch.setenv("HARBOR_HF_TASK_IMAGE", TASK_IMAGE)
    monkeypatch.setenv(
        "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY",
        MIRROR_REPOSITORY,
    )
    monkeypatch.setenv("HARBOR_HF_MAX_IMAGE_BYTES", str(20 * 1024 * 1024 * 1024))
    monkeypatch.setenv("HARBOR_HF_MAX_IMAGE_ENTRIES", "500000")
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: prepared_job)
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _run_id, _task_id: prepared_trial,
    )


def _config(monkeypatch: pytest.MonkeyPatch) -> worker.WorkerConfig:
    _configure(monkeypatch)
    return worker._locked_config(_lock())


def test_evidence_chunks_fit_the_encoded_api_limit() -> None:
    encoded_size = 4 * ((worker._EVIDENCE_CHUNK_BYTES + 2) // 3)
    assert encoded_size <= 12_000_000
    assert encoded_size + 100_000 < 16 * 1024 * 1024


@pytest.mark.parametrize(
    "assignment",
    [
        "[]",
        '["task-a","task-b"]',
        '[""]',
        '{"task_id":"task-a"}',
    ],
)
def test_requires_exactly_one_task_assignment(
    monkeypatch: pytest.MonkeyPatch,
    assignment: str,
) -> None:
    monkeypatch.setenv("HARBOR_HF_TASK_IDS_JSON", assignment)

    with pytest.raises(RuntimeError, match="exactly one"):
        worker._assigned_task_id()


def test_reads_one_prepared_worker_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(monkeypatch)

    assert config.harbor_version == "0.22.0"
    assert config.task.task_id == "task-a-trial-1"
    assert config.task.source_task_id == "task-a"
    assert config.task.trial_lock.task.digest == DIGEST
    assert config.task.trial_lock.environment.kwargs == {
        "control_max_command_seconds": 900,
        "control_max_transfer_bytes": 1024 * 1024 * 1024,
        "control_max_transfer_file_bytes": 512 * 1024 * 1024,
        "control_max_transfer_files": 10_000,
        "control_max_transfer_path_depth": 32,
        "control_max_image_bytes": 20 * 1024 * 1024 * 1024,
        "control_max_image_entries": 500_000,
        "control_declared_task_image": DECLARED_TASK_IMAGE,
        "control_task_image": TASK_IMAGE,
    }
    assert config.task.agent_timeout_seconds == 900
    assert config.task.timeout_seconds == 2_460


def test_accepts_python_float_after_javascript_json_round_trip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    prepared_job, prepared_trial = _prepared_records(lock)
    prepared_trial["trial_lock"]["timeout_multiplier"] = 1
    _configure(monkeypatch)
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: prepared_job)
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _run_id, _task_id: prepared_trial,
    )

    config = worker._locked_config(lock)

    assert config.task.trial_lock.timeout_multiplier == 1.0


def test_multi_task_run_fetches_only_the_assigned_prepared_trial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    lock["tasks"].append(
        {
            "task_id": "task-b-trial-1",
            "source_task_id": "task-b",
            "trial_index": 1,
            "input_digest": f"sha256:{'b' * 64}",
        }
    )
    prepared_job, prepared_trial = _prepared_records(lock)
    prepared_job["trials"].append(
        {
            "task_id": "task-b-trial-1",
            "record_id": "prepared-task-b",
            "record_digest": f"sha256:{'c' * 64}",
        }
    )
    _configure(monkeypatch)
    monkeypatch.setenv(
        "HARBOR_HF_RUN_LOCK_DIGEST",
        worker.digest_bytes(worker._canonical_json(lock)),
    )
    monkeypatch.setenv(
        "HARBOR_HF_PREPARED_JOB_DIGEST",
        worker.digest_bytes(worker._canonical_json(prepared_job)),
    )
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: prepared_job)
    requested: list[str] = []

    def read_trial(_run_id: str, task_id: str) -> dict:
        requested.append(task_id)
        return prepared_trial

    monkeypatch.setattr(worker, "_read_prepared_trial", read_trial)

    config = worker._locked_config(lock)

    assert config.task.task_id == "task-a-trial-1"
    assert requested == ["task-a-trial-1"]


def test_server_records_do_not_recompute_cross_language_digests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    lock = _lock()
    prepared_job, prepared_trial = _prepared_records(lock)
    lock["projection_metadata"] = {"mixedCase": "PreserveMe", "tiny": 1e-7}
    prepared_job["projectionMetadata"] = {"mixedCase": "PreserveMe", "tiny": 1e-7}
    prepared_trial["projectionMetadata"] = {"mixedCase": "PreserveMe", "tiny": 1e-7}
    monkeypatch.setenv("HARBOR_HF_PREPARED_JOB_DIGEST", f"sha256:{'f' * 64}")
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: prepared_job)
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _run_id, _task_id: prepared_trial,
    )

    assert worker._locked_config(lock).task.image == TASK_IMAGE


def test_rejects_a_physical_job_image_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("HARBOR_HF_JOB_IMAGE", f"example.invalid/other@{DIGEST}")

    with pytest.raises(worker.PreparedDataError, match="physical Job"):
        worker._locked_config(_lock())


def test_rejects_a_task_image_launch_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv(
        "HARBOR_HF_TASK_IMAGE",
        f"example.invalid/task@sha256:{'f' * 64}",
    )

    with pytest.raises(worker.PreparedDataError, match="launch action"):
        worker._locked_config(_lock())


def test_rejects_a_declared_harbor_environment_image_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    prepared_job, prepared_trial = _prepared_records(lock)
    prepared_trial["trial_lock"]["environment"]["kwargs"][
        "control_declared_task_image"
    ] = "example.invalid/other:release"
    prepared_trial["trial_lock_digest"] = worker.digest_json(
        prepared_trial["trial_lock"]
    )
    _configure(monkeypatch)
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: prepared_job)
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _run_id, _task_id: prepared_trial,
    )

    with pytest.raises(worker.PreparedDataError, match="environment image"):
        worker._locked_config(lock)


def test_rejects_a_changed_python_origin_trial_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    prepared_job, prepared_trial = _prepared_records(lock)
    prepared_trial["trial_lock"]["timeout_multiplier"] = 2.0
    _configure(monkeypatch)
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: prepared_job)
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _run_id, _task_id: prepared_trial,
    )

    with pytest.raises(worker.PreparedDataError, match="trial lock digest"):
        worker._locked_config(lock)


def test_rejects_task_outside_prepared_job(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("HARBOR_HF_TASK_IDS_JSON", '["other"]')

    with pytest.raises(RuntimeError, match="outside the prepared job"):
        worker._locked_config(_lock())


def test_reconstructs_portable_git_task(monkeypatch: pytest.MonkeyPatch) -> None:
    task = _config(monkeypatch).task

    assert worker._task_source(task) == {
        "path": "tasks/task-a",
        "git_url": "https://github.com/example/benchmark.git",
        "git_commit_id": "b" * 40,
    }


def test_harbor_run_config_uses_one_adhoc_task(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    config = _config(monkeypatch)

    path = worker._job_config(config, tmp_path)
    written = json.loads(path.read_text())

    assert written["datasets"] == []
    assert written["n_attempts"] == 1
    assert written["n_concurrent_trials"] == 1
    assert written["retry"]["max_retries"] == 0
    assert len(written["tasks"]) == 1
    assert written["tasks"][0]["path"] == "tasks/task-a"
    assert written["tasks"][0]["git_url"] == "https://github.com/example/benchmark.git"
    assert written["tasks"][0]["git_commit_id"] == "b" * 40
    assert written["tasks"][0]["source"] is None
    assert written["environment"]["kwargs"]["control_task_image"] == TASK_IMAGE


@pytest.mark.parametrize(
    ("result", "output", "timed_out", "expected"),
    [
        ({"exception_info": None}, "", False, ("complete", False)),
        (
            {"exception_info": {"exception_type": "DownloadVerifierDirError"}},
            "",
            False,
            ("infrastructure", True),
        ),
        (
            {"exception_info": {"exception_type": "TransientProviderError"}},
            "",
            False,
            ("infrastructure", True),
        ),
        (
            {"exception_info": {"exception_type": "ProviderPolicyError"}},
            "",
            False,
            ("policy", False),
        ),
        (
            {
                "exception_info": {"exception_type": "TerminalProviderError"},
                "agent_execution": {"started_at": "2026-08-25T00:00:00Z"},
            },
            "",
            False,
            ("agent", False),
        ),
        (None, "JobEnvironmentError", False, ("invalid", False)),
        (
            None,
            "JobEnvironmentPreflightError: dedicated task UID unavailable",
            False,
            ("infrastructure", True),
        ),
        (None, "AgentAuthenticationError", False, ("policy", False)),
        (None, "", True, ("benchmark_timeout", False)),
        (
            {
                "exception_info": {"exception_type": "VerifierOutputParseError"},
                "agent_execution": {"started_at": "2026-08-25T00:00:00Z"},
            },
            "",
            False,
            ("verifier", False),
        ),
        (
            {
                "exception_info": {"exception_type": "NetworkConnectionError"},
                "agent_setup": {"started_at": "2026-08-25T00:00:00Z"},
                "agent_execution": None,
            },
            "",
            False,
            ("infrastructure", True),
        ),
        (
            {
                "exception_info": {"exception_type": "RuntimeError"},
                "agent_execution": {"started_at": "2026-08-25T00:00:00Z"},
            },
            "",
            False,
            ("agent", False),
        ),
        (
            {
                "exception_info": {
                    "exception_type": "RuntimeError",
                    "exception_message": (
                        "control API returned HTTP 422: policy_rejected"
                    ),
                }
            },
            "",
            False,
            ("policy", False),
        ),
    ],
)
def test_classifies_terminal_outcomes(result, output, timed_out, expected) -> None:
    assert worker._exception_outcome(result, output, timed_out=timed_out) == expected


def test_computes_conservative_token_cost(monkeypatch: pytest.MonkeyPatch) -> None:
    config = _config(monkeypatch)
    result = {"agent_result": {"n_input_tokens": 1_000_000, "n_output_tokens": 500_000}}

    assert worker._cost_microusd(config, result) == 200_000


def test_provider_usage_overrides_untrusted_agent_token_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(monkeypatch)
    result = {"agent_result": {"n_input_tokens": 1, "n_output_tokens": 1}}
    usage = worker.InferenceUsage(
        requests=2,
        input_tokens=1_000_000,
        output_tokens=500_000,
    )

    assert worker._metrics(result, usage) == {
        "input_tokens": 1_000_000.0,
        "output_tokens": 500_000.0,
    }
    assert worker._cost_microusd(config, result, usage) == 200_000


@pytest.mark.parametrize(
    ("outcome", "replacement", "usage", "expected"),
    [
        (
            "complete",
            False,
            worker.InferenceUsage(requests=0, input_tokens=0, output_tokens=0),
            ("infrastructure", True),
        ),
        (
            "agent",
            False,
            worker.InferenceUsage(requests=1, input_tokens=0, output_tokens=0),
            ("infrastructure", True),
        ),
        (
            "benchmark_timeout",
            False,
            worker.InferenceUsage(requests=0, input_tokens=0, output_tokens=0),
            ("infrastructure", True),
        ),
        (
            "benchmark_timeout",
            False,
            worker.InferenceUsage(requests=1, input_tokens=10, output_tokens=2),
            ("benchmark_timeout", False),
        ),
        (
            "complete",
            False,
            worker.InferenceUsage(requests=1, input_tokens=10, output_tokens=2),
            ("complete", False),
        ),
        ("policy", False, None, ("policy", False)),
    ],
)
def test_missing_provider_usage_is_retryable_infrastructure(
    outcome: str,
    replacement: bool,
    usage: worker.InferenceUsage | None,
    expected: tuple[str, bool],
) -> None:
    assert worker._outcome_with_usage(outcome, replacement, usage) == expected


def test_streams_command_output_and_kills_a_hung_process(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO):
        output, timed_out = worker._run_logged_command(
            [
                sys.executable,
                "-c",
                "print('hello-from-worker', flush=True); import time; time.sleep(30)",
            ],
            1,
            dict(os.environ),
        )

    assert timed_out is True
    assert "hello-from-worker" in output
    assert "hello-from-worker" in caplog.text


def test_streams_command_output_with_injected_env() -> None:
    output, timed_out = worker._run_logged_command(
        [sys.executable, "-c", "import os; print(os.environ['HHF_PATCH'], flush=True)"],
        5,
        {**os.environ, "HHF_PATCH": "applied"},
    )

    assert timed_out is False
    assert "applied" in output


def test_harbor_child_environment_is_allowlisted() -> None:
    environment = {
        "PATH": "/usr/bin",
        "HOME": "/tmp/home",
        "HARBOR_HF_RUN_ID": "run-1",
        "HARBOR_HF_WORKER_CAPABILITY": "private-capability",
        "UNRELATED_SECRET": "must-not-enter",
        "ARBITRARY_VALUE": "must-not-enter",
    }

    assert worker._harbor_child_environment(
        environment,
        agent_timeout_seconds=900,
    ) == {
        "PATH": "/usr/bin",
        "HOME": "/tmp/home",
        "HARBOR_HF_RUN_ID": "run-1",
        "HARBOR_HF_WORKER_CAPABILITY": "private-capability",
        "HARBOR_HF_AGENT_TIMEOUT_SECONDS": "900",
    }


def test_redacts_sensitive_output_split_across_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "split-private-worker-token"
    monkeypatch.setattr(worker, "_LOG_READ_BYTES", 3)
    output, timed_out = worker._run_logged_command(
        [
            sys.executable,
            "-c",
            (
                "import os,sys,time;"
                "value=os.environ['TEST_API_TOKEN'];"
                "sys.stdout.write(value[:8]);sys.stdout.flush();"
                "time.sleep(0.05);"
                "sys.stdout.write(value[8:]);sys.stdout.flush()"
            ),
        ],
        5,
        {"PATH": os.environ["PATH"], "TEST_API_TOKEN": secret},
    )

    assert timed_out is False
    assert secret not in output
    assert "<redacted>" in output


def test_redacts_sensitive_output_around_malformed_utf8(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "private-token-boundary"
    monkeypatch.setattr(worker, "_LOG_READ_BYTES", 2)
    output, timed_out = worker._run_logged_command(
        [
            sys.executable,
            "-c",
            (
                "import os,sys;"
                "value=os.environ['TEST_API_TOKEN'].encode();"
                "sys.stdout.buffer.write(b'\\xff'+value+b'\\xfe');"
                "sys.stdout.buffer.flush()"
            ),
        ],
        5,
        {"PATH": os.environ["PATH"], "TEST_API_TOKEN": secret},
    )

    assert timed_out is False
    assert secret not in output
    assert "<redacted>" in output


def test_stops_descendant_that_keeps_output_pipe_open() -> None:
    started = os.times().elapsed
    output, timed_out = worker._run_logged_command(
        [
            sys.executable,
            "-c",
            (
                "import subprocess,sys;"
                "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);"
                "print('parent-finished',flush=True)"
            ),
        ],
        5,
        {"PATH": os.environ["PATH"]},
    )

    assert timed_out is False
    assert "parent-finished" in output
    assert os.times().elapsed - started < 5


def test_harbor_output_is_bounded_and_explicitly_truncated() -> None:
    output, timed_out = worker._run_logged_command(
        [sys.executable, "-c", "import sys; sys.stdout.write('x' * 1100000)"],
        5,
        dict(os.environ),
    )

    assert timed_out is False
    assert "[harbor-hf: output truncated]" in output
    assert len(output) < 1_100_000


def test_rejects_oversized_evidence_reads(tmp_path: Path) -> None:
    path = tmp_path / "result.json"
    path.write_bytes(b"1234")

    with pytest.raises(worker.WorkerEvidenceError, match="exceeds"):
        worker._read_bounded_file(path, 3, label="trial result")


def test_rejects_symlinks_and_excess_entries_in_trial_evidence(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    outside = tmp_path / "outside"
    outside.write_text("private")
    (evidence / "link").symlink_to(outside)

    with pytest.raises(worker.WorkerEvidenceError, match="symbolic link"):
        worker._regular_trial_files(evidence)

    (evidence / "link").unlink()
    (evidence / "one").write_text("1")
    (evidence / "two").write_text("2")
    monkeypatch.setattr(worker, "_MAX_EVIDENCE_ENTRIES", 1)
    with pytest.raises(worker.WorkerEvidenceError, match="entry count"):
        worker._regular_trial_files(evidence)


def test_rejects_multiple_durable_results(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    task = _config(monkeypatch).task
    task_root = tmp_path / "jobs" / task.task_id
    for name in ("trial-a", "trial-b"):
        trial = task_root / name
        trial.mkdir(parents=True)
        (trial / "result.json").write_text("{}")

    with pytest.raises(worker.WorkerEvidenceError, match="multiple trial results"):
        worker._result_path(tmp_path, task)


def test_rejects_sensitive_values_in_evidence_content_and_paths(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    config = _config(monkeypatch)
    secret = "private-evidence-token"
    monkeypatch.setenv("TEST_API_TOKEN", secret)
    trial = tmp_path / "trial"
    trial.mkdir()
    result_path = trial / "result.json"
    result_path.write_text('{"exception_info": null}')
    (trial / "lock.json").write_text(
        json.dumps(config.task.trial_lock.model_dump(mode="json"))
    )
    leaked = trial / "leaked.txt"
    leaked.write_text(f"prefix-{secret}-suffix")

    with pytest.raises(worker.WorkerEvidenceError, match="sensitive worker setting"):
        worker._verified_result(config.task, result_path)

    leaked.write_text("safe")
    leaked.rename(trial / f"artifact-{secret}.txt")
    with pytest.raises(worker.WorkerEvidenceError, match="sensitive worker setting"):
        worker._verified_result(config.task, result_path)


def test_runs_harbor_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    config = _config(monkeypatch)
    calls: list[list[str]] = []
    result_path = tmp_path / "result.json"
    monkeypatch.setattr(
        worker,
        "_run_logged_command",
        lambda command, _timeout, _env: calls.append(command) or ("429", False),
    )
    monkeypatch.setattr(worker, "_result_path", lambda _root, _task: result_path)

    assert worker._run_harbor(config, tmp_path, tmp_path / "config.json") == (
        "429",
        False,
        result_path,
    )
    assert len(calls) == 1


@pytest.mark.parametrize("timed_out", [False, True])
def test_missing_harbor_result_preserves_timeout_provenance(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    timed_out: bool,
) -> None:
    config = _config(monkeypatch)
    monkeypatch.setattr(
        worker,
        "_run_logged_command",
        lambda _command, _timeout, _env: ("", timed_out),
    )
    monkeypatch.setattr(worker, "_result_path", lambda _root, _task: None)

    with pytest.raises(
        worker.MissingHarborResultError,
        match="Harbor did not write a trial result",
    ) as captured:
        worker._run_harbor(config, tmp_path, tmp_path / "config.json")
    assert captured.value.timed_out is timed_out


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (worker.PreparedDataError("digest mismatch"), ("invalid", False)),
        (worker.WorkerEvidenceError("invalid evidence"), ("invalid", False)),
        (
            worker.MissingHarborResultError("missing result"),
            ("infrastructure", True),
        ),
        (
            worker.MissingHarborResultError("timed out", timed_out=True),
            ("benchmark_timeout", False),
        ),
        (worker.ProviderPolicyError(), ("policy", False)),
        (
            worker.ControlClientTransientError("control unavailable"),
            ("infrastructure", True),
        ),
        (
            worker.JobEnvironmentPreflightError("dedicated task UID unavailable"),
            ("infrastructure", True),
        ),
        (
            worker.InferenceUsageError("invalid provider usage"),
            ("infrastructure", True),
        ),
    ],
)
def test_only_typed_transient_worker_failures_are_replaceable(
    error: BaseException,
    expected: tuple[str, bool],
) -> None:
    assert worker._worker_failure_outcome(error) == expected


def test_failure_evidence_uploads_note_then_canonical_manifest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uploads: list[dict[str, object]] = []

    class Client:
        run_id = "run-1"
        prefix = "/api/v1/runs/run-1"

        def request_sync(
            self,
            _method,
            _path,
            idempotency_key=None,
            body=None,
            timeout_seconds=None,
            **_kwargs,
        ):
            del idempotency_key, timeout_seconds
            assert body is not None
            uploads.append(body)
            digest = str(body["digest"])
            return {
                "path": (
                    "evidence/schema=v1/runs/run-1/actions/action-1/"
                    "tasks/task-a-trial-1/objects/"
                    f"{digest.removeprefix('sha256:')}"
                )
            }

    client = Client()
    monkeypatch.setattr(worker, "_control_client", lambda _run_id: client)
    identity = worker.WorkerIdentity(
        run_id="run-1",
        action_id="action-1",
        task_id="task-a-trial-1",
    )

    manifest_digest, manifest_path = worker._upload_failure_note(
        identity,
        RuntimeError("failed"),
    )

    assert len(uploads) == 2
    note_upload, manifest_upload = uploads
    note_bytes = base64.b64decode(str(note_upload["content_base64"]))
    manifest_bytes = base64.b64decode(str(manifest_upload["content_base64"]))
    manifest = json.loads(manifest_bytes)
    assert manifest_bytes == worker._canonical_json(manifest)
    assert manifest["kind"] == "worker.evidence.manifest"
    assert manifest["objects"] == [
        {
            "path": (
                "evidence/schema=v1/runs/run-1/actions/action-1/"
                "tasks/task-a-trial-1/objects/"
                f"{str(note_upload['digest']).removeprefix('sha256:')}"
            ),
            "digest": note_upload["digest"],
            "size": len(note_bytes),
        }
    ]
    assert manifest_digest == manifest_upload["digest"]
    assert manifest_path.endswith(manifest_digest.removeprefix("sha256:"))


def test_records_one_attempt_for_pre_delivery_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    config = _config(monkeypatch)
    monkeypatch.setattr(
        worker,
        "_run_task_once",
        lambda _config, _root: (_ for _ in ()).throw(RuntimeError("failed")),
    )
    monkeypatch.setattr(
        worker,
        "_submit_failure_attempt",
        lambda _identity, error, **kwargs: attempts.append(
            {"output": str(error), **kwargs}
        ),
    )
    attempts: list[dict[str, object]] = []

    worker._run_task(config, tmp_path)

    assert attempts == [
        {
            "output": "failed",
            "outcome": "invalid",
            "replacement_eligible": False,
        }
    ]


def test_capability_leak_is_not_uploaded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    config = _config(monkeypatch)
    monkeypatch.setattr(
        worker,
        "_run_task_once",
        lambda _config, _root: (_ for _ in ()).throw(
            RuntimeError("sensitive worker setting leaked into trial evidence")
        ),
    )
    monkeypatch.setattr(
        worker,
        "_submit_failure_attempt",
        lambda _config, _error: pytest.fail("must not upload leaked evidence"),
    )

    with pytest.raises(RuntimeError, match="sensitive worker setting leaked"):
        worker._run_task(config, tmp_path)

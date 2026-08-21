from __future__ import annotations

import concurrent.futures
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from threading import Event

import pytest

from harbor_hf_agents.support import control_campaign_worker as worker

DIGEST = f"sha256:{'a' * 64}"


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
                "harbor_hf_agents.support.control_sandbox_environment:"
                "ControlSandboxEnvironment"
            ),
            "delete": True,
            "kwargs": {
                "control_task_id": "task-a-trial-1",
                "control_max_command_seconds": 900,
            },
        },
        "verifier": {"disable": False},
    }


def _lock() -> dict:
    return {
        "campaign_id": "campaign-1",
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
                    "harbor_version": "0.21.0",
                    "worker_revision": "abcdef0",
                    "worker_concurrency": 4,
                    "worker_max_tasks_per_job": 1,
                    "input_price_microusd_per_million_tokens": 100_000,
                    "output_price_microusd_per_million_tokens": 200_000,
                },
            }
        ],
    }


def _prepared_job() -> dict:
    return {
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
        "trials": [
            {
                "task_id": "task-a-trial-1",
                "record_id": "prepared-task-a",
                "record_digest": DIGEST,
            }
        ],
    }


def _prepared_trial() -> dict:
    return {
        "record_id": "prepared-task-a",
        "task_id": "task-a-trial-1",
        "source_task_id": "task-a",
        "trial_index": 1,
        "input_digest": DIGEST,
        "declared_image": "example.invalid/task:release",
        "image": f"example.invalid/task@{DIGEST}",
        "agent_timeout_seconds": 900,
        "verifier_timeout_seconds": 600,
        "environment_build_timeout_seconds": 600,
        "agent_setup_timeout_seconds": 360,
        "trial_lock": _trial_lock(),
    }


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CAMPAIGN_ID", "campaign-1")
    monkeypatch.setenv("HARBOR_HF_ACTION_ID", "action-1")
    monkeypatch.setenv("HARBOR_HF_TASK_IDS_JSON", '["task-a-trial-1"]')
    monkeypatch.setattr(worker, "_read_prepared_job", lambda _: _prepared_job())
    monkeypatch.setattr(
        worker, "_read_prepared_trial", lambda _c, _t: _prepared_trial()
    )


def test_evidence_chunks_fit_the_encoded_api_limit() -> None:
    encoded_size = 4 * ((worker._EVIDENCE_CHUNK_BYTES + 2) // 3)
    assert encoded_size <= 12_000_000
    assert encoded_size + 100_000 < 16 * 1024 * 1024


def test_reads_exact_prepared_worker_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)

    config = worker._locked_config(_lock())

    assert config.harbor_version == "0.21.0"
    assert config.max_tasks_per_job == 1
    assert len(config.tasks) == 1
    assert config.tasks[0].task_id == "task-a-trial-1"
    assert config.tasks[0].source_task_id == "task-a"
    assert config.tasks[0].trial_lock.task.digest == DIGEST
    assert config.tasks[0].trial_lock.environment.kwargs == {
        "control_task_id": "task-a-trial-1",
        "control_max_command_seconds": 900,
    }
    assert config.tasks[0].timeout_seconds == 2_460


def test_rejects_oversized_worker_assignment(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv(
        "HARBOR_HF_TASK_IDS_JSON",
        '["task-a-trial-1","task-b-trial-1"]',
    )

    with pytest.raises(RuntimeError, match="exceeds its locked task limit"):
        worker._locked_config(_lock())


def test_rejects_task_outside_prepared_job(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("HARBOR_HF_TASK_IDS_JSON", '["other"]')

    with pytest.raises(RuntimeError, match="outside the prepared job"):
        worker._locked_config(_lock())


def test_reconstructs_portable_git_task(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    task = worker._locked_config(_lock()).tasks[0]

    assert worker._task_source(task) == {
        "path": "tasks/task-a",
        "git_url": "https://github.com/example/benchmark.git",
        "git_commit_id": "b" * 40,
    }


def test_omits_dataset_source_from_harbor_run_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    lock = _trial_lock()
    lock["task"]["source"] = "example-dataset"
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _c, _t: {**_prepared_trial(), "trial_lock": lock},
    )
    task = worker._locked_config(_lock()).tasks[0]
    payload = worker._task_source(task)

    assert task.trial_lock.task.source == "example-dataset"
    assert "source" not in payload
    assert payload == {
        "path": "tasks/task-a",
        "git_url": "https://github.com/example/benchmark.git",
        "git_commit_id": "b" * 40,
    }


def test_harbor_run_config_uses_adhoc_progress_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _configure(monkeypatch)
    lock = _trial_lock()
    lock["task"]["source"] = "example-dataset"
    monkeypatch.setattr(
        worker,
        "_read_prepared_trial",
        lambda _c, _t: {**_prepared_trial(), "trial_lock": lock},
    )
    config = worker._locked_config(_lock())
    path = worker._job_config(config, config.tasks[0], tmp_path)
    written = json.loads(path.read_text())
    task_config = written["tasks"][0]

    assert task_config["source"] != "example-dataset"
    assert written["datasets"] == []


def test_stops_new_work_when_campaign_state_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _configure(monkeypatch)
    config = worker._locked_config(_lock())

    class UnavailableClient:
        def __init__(self, _campaign_id: str, _task_id: str) -> None:
            pass

        def request(self, *_args, **_kwargs):
            raise RuntimeError("control unavailable")

    monkeypatch.setattr(worker, "_ControlClient", UnavailableClient)

    assert worker._campaign_cancelled(config) is True
    assert "campaign_state_unavailable" in capsys.readouterr().out


def _scheduler_config(
    monkeypatch: pytest.MonkeyPatch, *, task_count: int = 3
) -> worker.WorkerConfig:
    _configure(monkeypatch)
    monkeypatch.setattr(worker, "_campaign_cancelled", lambda _config: False)
    config = worker._locked_config(_lock())
    task = config.tasks[0]
    tasks = tuple(replace(task, task_id=f"task-{index}") for index in range(task_count))
    return replace(
        config,
        concurrency=2,
        max_tasks_per_job=task_count,
        tasks=tasks,
    )


def test_refills_available_worker_slot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = _scheduler_config(monkeypatch)
    first_started = Event()
    release_first = Event()
    third_started = Event()

    def fake_run_task(
        _config: worker.WorkerConfig, task: worker.LockedTask, _root: Path
    ) -> str:
        if task.task_id == "task-0":
            first_started.set()
            assert release_first.wait(timeout=5)
        elif task.task_id == "task-2":
            third_started.set()
        return task.task_id

    monkeypatch.setattr(worker, "_run_task", fake_run_task)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as supervisor:
        future = supervisor.submit(worker._run_assigned_tasks, config, tmp_path)
        assert first_started.wait(timeout=1)
        assert third_started.wait(timeout=1)
        assert not release_first.is_set()
        release_first.set()
        completed, failures = future.result(timeout=2)

    assert set(completed) == {"task-0", "task-1", "task-2"}
    assert failures == []


def test_stops_refilling_after_campaign_cancellation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = _scheduler_config(monkeypatch)
    cancellation_checks = iter([False, True, True])
    monkeypatch.setattr(
        worker,
        "_campaign_cancelled",
        lambda _config: next(cancellation_checks, True),
    )
    third_started = Event()

    def fake_run_task(
        _config: worker.WorkerConfig, task: worker.LockedTask, _root: Path
    ) -> str:
        if task.task_id == "task-2":
            third_started.set()
        return task.task_id

    monkeypatch.setattr(worker, "_run_task", fake_run_task)
    completed, failures = worker._run_assigned_tasks(config, tmp_path)

    assert set(completed) == {"task-0", "task-1"}
    assert failures == []
    assert not third_started.is_set()


def test_stops_refilling_after_task_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = _scheduler_config(monkeypatch)
    release_second = Event()
    third_started = Event()

    def fake_run_task(
        _config: worker.WorkerConfig, task: worker.LockedTask, _root: Path
    ) -> str:
        if task.task_id == "task-0":
            raise RuntimeError("deterministic failure")
        if task.task_id == "task-1":
            assert release_second.wait(timeout=5)
        if task.task_id == "task-2":
            third_started.set()
        return task.task_id

    monkeypatch.setattr(worker, "_run_task", fake_run_task)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as supervisor:
        future = supervisor.submit(worker._run_assigned_tasks, config, tmp_path)
        release_second.set()
        completed, failures = future.result(timeout=2)

    assert completed == ["task-1"]
    assert len(failures) == 1
    assert isinstance(failures[0], RuntimeError)
    assert not third_started.is_set()


@pytest.mark.parametrize(
    ("result", "stderr", "timed_out", "expected"),
    [
        ({"exception_info": None}, "", False, ("complete", False)),
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
            {"exception_info": {"exception_type": "TerminalProviderError"}},
            "",
            False,
            ("agent", False),
        ),
        (
            {
                "exception_info": {
                    "exception_type": "IndexError",
                    "exception_traceback": "Job._update_metric_display",
                }
            },
            "",
            False,
            ("complete", False),
        ),
        (None, "Sandbox API failed", False, ("infrastructure", True)),
        (None, "IndexError: list index out of range", False, ("infrastructure", True)),
        (
            {"exception_info": None},
            "IndexError: list index out of range\n_update_metric_display",
            False,
            ("complete", False),
        ),
        (None, "AgentAuthenticationError", False, ("policy", False)),
        (None, "", True, ("benchmark_timeout", False)),
        (
            {"exception_info": {"exception_type": "VerifierOutputParseError"}},
            "",
            False,
            ("verifier", False),
        ),
        (
            {
                "exception_info": {
                    "exception_type": "RuntimeError",
                    "exception_message": "control Sandbox API returned HTTP 500",
                }
            },
            "",
            False,
            ("infrastructure", True),
        ),
        (
            {
                "exception_info": {
                    "exception_type": "RuntimeError",
                    "exception_message": (
                        "control Sandbox API returned HTTP 422: policy_rejected"
                    ),
                }
            },
            "",
            False,
            ("policy", False),
        ),
    ],
)
def test_classifies_terminal_outcomes(result, stderr, timed_out, expected) -> None:
    assert worker._exception_outcome(result, stderr, timed_out=timed_out) == expected


def test_computes_conservative_token_cost(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    config = worker._locked_config(_lock())
    result = {"agent_result": {"n_input_tokens": 1_000_000, "n_output_tokens": 500_000}}

    assert worker._cost_microusd(config, result) == 200_000


def test_streams_command_output_and_kills_a_hung_process(
    capsys: pytest.CaptureFixture[str],
) -> None:
    output, timed_out = worker._run_logged_command(
        [
            sys.executable,
            "-c",
            "print('hello-from-worker', flush=True); import time; time.sleep(30)",
        ],
        1,
    )

    assert timed_out is True
    assert "hello-from-worker" in output
    assert "hello-from-worker" in capsys.readouterr().out


def test_streams_command_output_with_injected_env() -> None:
    output, timed_out = worker._run_logged_command(
        [sys.executable, "-c", "import os; print(os.environ['HHF_PATCH'], flush=True)"],
        5,
        {**os.environ, "HHF_PATCH": "applied"},
    )

    assert timed_out is False
    assert "applied" in output

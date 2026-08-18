from __future__ import annotations

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


@pytest.mark.parametrize(
    ("result", "stderr", "timed_out", "expected"),
    [
        ({"exception_info": None}, "", False, ("complete", False)),
        (None, "Sandbox API failed", False, ("infrastructure", True)),
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

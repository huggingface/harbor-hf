from __future__ import annotations

import pytest

from harbor_hf_agents.support import control_campaign_worker as worker

DIGEST = f"sha256:{'a' * 64}"


def _lock() -> dict:
    sandbox = {
        "image": f"example.invalid/base@{DIGEST}",
        "hardware": "cpu-basic",
        "timeout_seconds": 7200,
        "idle_timeout_seconds": 3600,
        "inference_token": "required",
        "inference_upstream": "https://router.huggingface.co",
        "inference_model": "example/model:together",
        "inference_api": "chat-completions",
        "inference_max_requests": 256,
        "inference_max_concurrency": 1,
        "inference_timeout_seconds": 1800,
        "inference_max_output_tokens": 32768,
        "root_bootstrap_command": ["/root/start"],
        "reservation_microusd": 20000,
        "active_hourly_cost_microusd": 10000,
        "max_sandboxes": 2,
        "max_commands": 128,
        "max_command_seconds": 3600,
        "max_transfer_bytes": 67108864,
        "allowed_roots": ["/app", "/logs", "/tmp"],
    }
    return {
        "campaign_id": "campaign-1",
        "tasks": [{"task_id": "task-a-trial-1", "input_digest": DIGEST}],
        "profiles": [
            {
                "kind": "benchmark",
                "spec": {
                    "benchmark": "terminal-bench-2-1",
                    "revision": "b" * 40,
                    "task_ids": ["task-a-trial-1"],
                    "task_digests": [DIGEST],
                    "source_repository": "https://github.com/example/benchmark.git",
                    "source_path": "tasks",
                    "trials_per_source_task": 1,
                },
            },
            {
                "kind": "model",
                "spec": {"model_id": "example/model", "revision": "c" * 40},
            },
            {
                "kind": "harness",
                "spec": {
                    "agent": "pi",
                    "revision": "0.84.2",
                    "required_evidence": ["workspace"],
                    "reasoning_effort": "high",
                },
            },
            {
                "kind": "deployment",
                "spec": {
                    "route": "hf_job",
                    "models": ["model"],
                    "harnesses": ["harness"],
                    "job_image": f"example.invalid/worker@{DIGEST}",
                    "job_command": ["true"],
                    "hardware": "cpu-upgrade",
                    "timeout_seconds": 86400,
                    "trusted_worker": True,
                    "inference_token": "forbidden",
                    "sandbox": sandbox,
                    "task_sandboxes": [
                        {
                            "task_id": "task-a-trial-1",
                            "source_task_id": "task-a",
                            "trial_index": 1,
                            "image": f"example.invalid/task@{DIGEST}",
                            "hardware": "cpu-basic",
                            "timeout_seconds": 7200,
                            "idle_timeout_seconds": 3600,
                            "reservation_microusd": 20000,
                            "active_hourly_cost_microusd": 10000,
                            "max_command_seconds": 3600,
                        }
                    ],
                    "inference_provider": "together",
                    "input_price_microusd_per_million_tokens": 140000,
                    "output_price_microusd_per_million_tokens": 280000,
                    "harbor_version": "0.21.0",
                    "worker_revision": "abcdef0",
                    "worker_concurrency": 4,
                    "worker_max_tasks_per_job": 1,
                    "context_window": 131072,
                },
            },
        ],
    }


def test_reads_exact_locked_worker_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HARBOR_HF_CAMPAIGN_ID", "campaign-1")
    monkeypatch.setenv("HARBOR_HF_ACTION_ID", "action-1")

    config = worker._locked_config(_lock())

    assert config.routed_model == "example/model:together"
    assert config.harbor_version == "0.21.0"
    assert config.max_tasks_per_job == 1
    assert config.tasks == (
        worker.LockedTask(
            task_id="task-a-trial-1",
            source_task_id="task-a",
            trial_index=1,
            input_digest=DIGEST,
            image=f"example.invalid/task@{DIGEST}",
            timeout_seconds=7200,
        ),
    )


def test_rejects_unassigned_task_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CAMPAIGN_ID", "campaign-1")
    monkeypatch.setenv("HARBOR_HF_ACTION_ID", "action-1")
    value = _lock()
    value["profiles"][3]["spec"]["task_sandboxes"][0]["task_id"] = "other"

    with pytest.raises(RuntimeError, match="do not match assigned"):
        worker._locked_config(value)


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
    ],
)
def test_classifies_terminal_outcomes(result, stderr, timed_out, expected) -> None:
    assert worker._exception_outcome(result, stderr, timed_out=timed_out) == expected


def test_computes_conservative_token_cost(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CAMPAIGN_ID", "campaign-1")
    monkeypatch.setenv("HARBOR_HF_ACTION_ID", "action-1")
    config = worker._locked_config(_lock())
    result = {"agent_result": {"n_input_tokens": 1_000_000, "n_output_tokens": 500_000}}

    assert worker._cost_microusd(config, result) == 280_000

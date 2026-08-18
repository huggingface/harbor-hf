from __future__ import annotations

from pathlib import Path

import pytest

from harbor_hf_agents.support import control_prepare_worker as worker

DIGEST = f"sha256:{'a' * 64}"


def _campaign_lock() -> dict:
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
                "kind": "benchmark",
                "spec": {
                    "harbor_job": {
                        "n_attempts": 1,
                        "datasets": [
                            {
                                "repo": "https://github.com/example/tasks.git@abcdef0",
                                "path": "tasks",
                            }
                        ],
                    }
                },
            },
            {
                "kind": "model",
                "spec": {
                    "harbor_model_name": "openai/example/model:provider",
                },
            },
            {
                "kind": "harness",
                "spec": {
                    "harbor_agent": {
                        "import_path": "example.agent:Agent",
                        "model_name": "openai/example/model:provider",
                        "kwargs": {"version": "1.0.0"},
                    }
                },
            },
            {
                "kind": "deployment",
                "spec": {"preparation": "required"},
            },
        ],
    }


def test_builds_generic_harbor_job_without_name_branches() -> None:
    config = worker._job_config(_campaign_lock())

    assert config.n_attempts == 1
    assert config.retry.max_retries == 0
    assert len(config.agents) == 1
    assert config.agents[0].import_path == "example.agent:Agent"
    assert config.agents[0].model_name == "openai/example/model:provider"
    assert config.environment.import_path.endswith(":ControlSandboxEnvironment")


def test_rejects_benchmark_control_fields() -> None:
    value = _campaign_lock()
    value["profiles"][0]["spec"]["harbor_job"]["agents"] = []

    with pytest.raises(RuntimeError, match="cannot set control field agents"):
        worker._job_config(value)


def test_reads_exact_campaign_task_mapping() -> None:
    assert worker._expected_tasks(_campaign_lock()) == (
        worker.ExpectedTask(
            task_id="task-a-trial-1",
            source_task_id="task-a",
            trial_index=1,
            input_digest=DIGEST,
        ),
    )


def test_keeps_digest_pinned_images_unchanged() -> None:
    image = f"example.invalid/task@{DIGEST}"
    assert worker._locked_image(image) == image


def test_parses_docker_hub_image_names() -> None:
    assert worker._parse_image("example/task:release") == (
        "registry-1.docker.io",
        "example/task",
        "release",
    )


def test_rejects_task_without_prebuilt_image(tmp_path: Path) -> None:
    task = tmp_path / "task"
    task.mkdir()
    (task / "task.toml").write_text(
        """
schema_version = "1.1"
[task]
name = "example/task"
[agent]
timeout_sec = 60
[verifier]
timeout_sec = 60
[environment]
cpus = 1
memory_mb = 1024
storage_mb = 1024
""".strip()
        + "\n"
    )

    with pytest.raises(RuntimeError, match="requires a prebuilt task image"):
        worker._task_definition(task)

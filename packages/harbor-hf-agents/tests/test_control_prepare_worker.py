from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from harbor.models.job.lock import TrialLock
from harbor.models.task.config import TaskConfig as TaskDefinitionConfig

from harbor_hf_agents.support import control_prepare_worker as worker

DIGEST = f"sha256:{'a' * 64}"


def _run_lock() -> dict:
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
        "execution": {
            "contract_version": "v1",
            "deployment": {"preparation": "required"},
            "model": {
                "harbor_model_name": "openai/example/model:provider",
            },
            "harbor_agent": {
                "import_path": "example.agent:Agent",
                "model_name": "openai/example/model:provider",
                "kwargs": {"version": "1.0.0"},
            },
        },
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
    config = worker._job_config(_run_lock())

    assert config.n_attempts == 1
    assert config.retry.max_retries == 0
    assert len(config.agents) == 1
    assert config.agents[0].import_path == "example.agent:Agent"
    assert config.agents[0].model_name == "openai/example/model:provider"
    assert config.environment.import_path.endswith(":ControlJobEnvironment")


def test_injects_the_locked_model_when_the_harness_is_model_independent() -> None:
    value = _run_lock()
    del value["execution"]["harbor_agent"]["model_name"]

    config = worker._job_config(value)

    assert config.agents[0].model_name == "openai/example/model:provider"


def test_preserves_direct_inference_agent_environment() -> None:
    value = _run_lock()
    value["execution"]["harbor_agent"]["env"] = {
        "OPENAI_API_KEY": "${HF_INFERENCE_TOKEN}",
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
        "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
    }

    config = worker._job_config(value)

    assert config.agents[0].env == {
        "OPENAI_API_KEY": "${HF_INFERENCE_TOKEN}",
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
        "HARBOR_HF_MAX_OUTPUT_TOKENS": "32768",
    }


def test_preserves_nested_command_agent_configuration_during_preparation() -> None:
    value = _run_lock()
    command_config = {
        "schema_version": "v1",
        "setup": {
            "script": "install-agent",
            "bindings": {"AGENT_HOME": "agent_home"},
            "literals": {},
        },
        "run": {
            "script": "run-agent",
            "bindings": {
                "MODEL_BASE_URL": "model_base_url",
                "GENERIC_API_KEY": "model_api_key",
            },
            "literals": {"OUTPUT_PATH": "/logs/agent/result.json"},
        },
        "route_api": "chat-completions",
        "outputs": [{"path": "result.json"}],
        "atif": {"path": "trajectory.json"},
    }
    harbor_agent = value["execution"]["harbor_agent"]
    del harbor_agent["model_name"]
    harbor_agent["import_path"] = "harbor_hf_agents.command_agent.agent:CommandAgent"
    harbor_agent["override_setup_timeout_sec"] = 1800
    harbor_agent["kwargs"] = {"config": command_config}

    config = worker._job_config(value)

    assert config.agents[0].model_name == "openai/example/model:provider"
    assert config.agents[0].import_path == (
        "harbor_hf_agents.command_agent.agent:CommandAgent"
    )
    assert config.agents[0].override_setup_timeout_sec == 1800
    assert config.agents[0].kwargs == {"config": command_config}
    assert config.model_dump(mode="json")["agents"][0]["kwargs"] == {
        "config": command_config,
    }


def test_rejects_a_harness_locked_to_a_different_model() -> None:
    value = _run_lock()
    value["execution"]["harbor_agent"]["model_name"] = "other/model"

    with pytest.raises(RuntimeError, match="does not match"):
        worker._job_config(value)


def test_rejects_benchmark_control_fields() -> None:
    value = _run_lock()
    value["profiles"][0]["spec"]["harbor_job"]["agents"] = []

    with pytest.raises(RuntimeError, match="cannot set control field agents"):
        worker._job_config(value)


def test_reads_exact_run_task_mapping() -> None:
    assert worker._expected_tasks(_run_lock()) == (
        worker.ExpectedTask(
            task_id="task-a-trial-1",
            source_task_id="task-a",
            trial_index=1,
            input_digest=DIGEST,
        ),
    )


def test_locks_the_prepared_command_limit_into_the_environment() -> None:
    source = TrialLock.model_validate(
        {
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
                "model_name": "openai/example/model:provider",
                "kwargs": {},
            },
            "skills": [],
            "environment": {"delete": True},
            "verifier": {"disable": False},
        }
    )

    prepared = worker._execution_trial_lock(
        source,
        900,
        20 * 1024 * 1024 * 1024,
        500_000,
        "example.invalid/task:release",
        f"example.invalid/task@{DIGEST}",
    )

    assert prepared.environment.kwargs == {
        "control_max_command_seconds": 900,
        "control_max_transfer_bytes": 1024 * 1024 * 1024,
        "control_max_transfer_file_bytes": 512 * 1024 * 1024,
        "control_max_transfer_files": 10_000,
        "control_max_transfer_path_depth": 32,
        "control_max_image_bytes": 20 * 1024 * 1024 * 1024,
        "control_max_image_entries": 500_000,
        "control_declared_task_image": "example.invalid/task:release",
        "control_task_image": f"example.invalid/task@{DIGEST}",
    }


def test_trial_submission_includes_python_origin_lock_digest() -> None:
    harbor_lock = TrialLock.model_validate(
        {
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
                "model_name": "openai/example/model:provider",
                "override_setup_timeout_sec": 1200,
                "kwargs": {},
            },
            "skills": [],
            "environment": {"delete": True},
            "verifier": {"disable": False},
        }
    )
    definition = cast(
        TaskDefinitionConfig,
        SimpleNamespace(
            agent=SimpleNamespace(timeout_sec=60),
            verifier=SimpleNamespace(timeout_sec=60),
            environment=SimpleNamespace(
                build_timeout_sec=60,
                docker_image="example.invalid/task:release",
                cpus=1,
                memory_mb=2048,
                storage_mb=10240,
                gpus=0,
            ),
        ),
    )
    expected = worker.ExpectedTask(
        task_id="task-a-trial-1",
        source_task_id="task-a",
        trial_index=1,
        input_digest=DIGEST,
    )
    _, body = worker._trial_body(
        expected,
        harbor_lock,
        definition,
        f"example.invalid/task@{DIGEST}",
        {
            "max_image_bytes": 20 * 1024 * 1024 * 1024,
            "max_image_entries": 500_000,
            "default_cpus": 1,
            "default_memory_mb": 2048,
            "default_storage_mb": 10240,
            "default_gpus": 0,
        },
    )

    assert body["trial_lock_digest"] == worker.digest_json(body["trial_lock"])
    assert body["agent_setup_timeout_seconds"] == 1200
    assert (
        body["trial_lock"]["environment"]["kwargs"]["control_max_command_seconds"]
        == 1200
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


def test_rejects_a_separate_verifier_image(tmp_path: Path) -> None:
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
environment_mode = "separate"
[verifier.environment]
docker_image = "example/verifier:release"
[environment]
docker_image = "example/task:release"
cpus = 1
memory_mb = 1024
storage_mb = 1024
""".strip()
        + "\n"
    )

    with pytest.raises(RuntimeError, match="separate verifier image"):
        worker._task_definition(task)

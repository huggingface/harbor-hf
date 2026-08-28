"""Resolve a Harbor job and submit its immutable trial locks."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import NAMESPACE_URL, uuid5

from harbor.job_plan import JobPlan
from harbor.models.job.config import JobConfig
from harbor.models.job.lock import TrialLock
from harbor.models.task.config import TaskConfig as TaskDefinitionConfig
from harbor.models.trial.config import EnvironmentConfig

from harbor_hf_agents.support.control_client import (
    ControlClient,
    digest_json,
    run_lock_profile,
)

_LOGGER = logging.getLogger(__name__)

_ACCEPT_MANIFESTS = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)
_BEARER_PARAMETER = re.compile(r'(\w+)="([^"]*)"')
_MAX_TRANSFER_BYTES = 1024 * 1024 * 1024
_MAX_TRANSFER_FILE_BYTES = 512 * 1024 * 1024
_MAX_TRANSFER_FILES = 10_000
_MAX_TRANSFER_PATH_DEPTH = 32


@dataclass(frozen=True)
class ExpectedTask:
    task_id: str
    source_task_id: str
    trial_index: int
    input_digest: str


def _required(name: str) -> str:
    try:
        value = os.environ[name]
    except KeyError as error:
        raise RuntimeError(
            f"required preparation worker setting {name} is missing"
        ) from error
    if not value:
        raise RuntimeError(f"required preparation worker setting {name} is empty")
    return value


def _optional(
    mapping: dict[str, Any],
    key: str,
) -> Any:  # noqa: ANN401 -- validated JSON values remain dynamic at this boundary
    try:
        return mapping[key]
    except KeyError:
        return None


def _read_run_lock(run_id: str) -> dict[str, Any]:
    client = ControlClient.from_environment()
    if client.run_id != run_id:
        raise RuntimeError("preparation worker run does not match its control client")
    return client.request_sync(
        "GET",
        f"/api/v1/runs/{run_id}/lock",
        idempotency_key=f"prepare-lock-{_required('HARBOR_HF_ACTION_ID')}",
        timeout_seconds=60,
    )


def _expected_tasks(lock: dict[str, Any]) -> tuple[ExpectedTask, ...]:
    output: list[ExpectedTask] = []
    tasks = lock["tasks"]
    if not isinstance(tasks, list):
        raise RuntimeError("run lock tasks must be a list")
    for value in tasks:
        if not isinstance(value, dict):
            raise RuntimeError("run task lock must be an object")
        output.append(
            ExpectedTask(
                task_id=str(value["task_id"]),
                source_task_id=str(value["source_task_id"]),
                trial_index=int(value["trial_index"]),
                input_digest=str(value["input_digest"]),
            )
        )
    if not output:
        raise RuntimeError("run must contain at least one task")
    if len({item.task_id for item in output}) != len(output):
        raise RuntimeError("run task IDs must be unique")
    if len({(item.source_task_id, item.trial_index) for item in output}) != len(output):
        raise RuntimeError("run source task trials must be unique")
    return tuple(output)


def _job_config(lock: dict[str, Any]) -> JobConfig:
    benchmark = run_lock_profile(lock, "benchmark")
    execution = _optional(lock, "execution")
    if not isinstance(execution, dict) or execution.get("contract_version") != "v1":
        raise RuntimeError("historical run locks cannot create prepared work")
    deployment = _optional(execution, "deployment")
    raw_agent = _optional(execution, "harbor_agent")
    raw_job = _optional(benchmark, "harbor_job")
    if (
        not isinstance(deployment, dict)
        or not isinstance(raw_job, dict)
        or not isinstance(raw_agent, dict)
    ):
        raise RuntimeError("resolved execution contract is incomplete")
    if deployment.get("preparation") != "required":
        raise RuntimeError("locked deployment does not require Harbor preparation")
    for key in ("agents", "environment", "retry", "job_name", "jobs_dir"):
        if key in raw_job:
            raise RuntimeError(f"benchmark Harbor job cannot set control field {key}")
    agent = copy.deepcopy(raw_agent)
    value = copy.deepcopy(raw_job)
    value.update(
        {
            "job_name": f"prepare-{lock['run_id']}",
            "jobs_dir": "/tmp/harbor-hf-prepared-jobs",
            "agents": [agent],
            "environment": {
                "import_path": (
                    "harbor_hf_agents.support.control_job_environment:"
                    "ControlJobEnvironment"
                ),
                "delete": True,
                "kwargs": {},
            },
            "retry": {"max_retries": 0},
        }
    )
    config = JobConfig.model_validate(value)
    if len(config.agents) != 1 or config.retry.max_retries != 0:
        raise RuntimeError("prepared Harbor job must use one agent and no retries")
    return config


def _parse_image(image: str) -> tuple[str, str, str]:
    if "@sha256:" in image:
        name, digest = image.rsplit("@", 1)
        return "", name, digest
    first, slash, rest = image.partition("/")
    if slash and ("." in first or ":" in first or first == "localhost"):
        registry = first
        repository = rest
    else:
        registry = "registry-1.docker.io"
        repository = image
    if registry == "docker.io":
        registry = "registry-1.docker.io"
    if registry == "registry-1.docker.io" and "/" not in repository:
        repository = f"library/{repository}"
    tail = repository.rsplit("/", 1)[-1]
    if ":" in tail:
        repository, reference = repository.rsplit(":", 1)
    else:
        reference = "latest"
    if not repository or not reference:
        raise RuntimeError("task image reference is invalid")
    return registry, repository, reference


def _bearer_token(challenge: str) -> str:
    if not challenge.lower().startswith("bearer "):
        raise RuntimeError("OCI registry did not offer bearer authentication")
    values = dict(_BEARER_PARAMETER.findall(challenge[7:]))
    realm = values.pop("realm", None)
    if not realm:
        raise RuntimeError("OCI bearer challenge has no realm")
    request = Request(
        f"{realm}?{urlencode(values)}", headers={"Accept": "application/json"}
    )
    with urlopen(request, timeout=30) as response:  # noqa: S310 -- reviewed HTTPS registry URL
        payload = json.load(response)
    token = payload["token"] if "token" in payload else payload["access_token"]
    if not isinstance(token, str) or not token:
        raise RuntimeError("OCI registry token response is invalid")
    return token


def _manifest_digest(registry: str, repository: str, reference: str) -> str:
    url = f"https://{registry}/v2/{repository}/manifests/{reference}"
    headers = {"Accept": _ACCEPT_MANIFESTS}
    request = Request(url, method="HEAD", headers=headers)
    try:
        response = urlopen(request, timeout=30)  # noqa: S310 -- reviewed HTTPS registry URL
    except HTTPError as error:
        if error.code != 401:
            raise RuntimeError(
                f"OCI manifest request failed with HTTP {error.code}"
            ) from error
        token = _bearer_token(error.headers["WWW-Authenticate"] or "")
        headers["Authorization"] = f"Bearer {token}"
        response = urlopen(  # noqa: S310 -- reviewed HTTPS registry URL
            Request(url, method="HEAD", headers=headers),
            timeout=30,
        )
    with response:
        digest = response.headers["Docker-Content-Digest"]
    if not digest or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("OCI registry did not return a valid manifest digest")
    return digest


def _locked_image(image: str) -> str:
    registry, repository, reference = _parse_image(image)
    if not registry:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", reference):
            raise RuntimeError("task image digest is invalid")
        return f"{repository}@{reference}"
    digest = _manifest_digest(registry, repository, reference)
    public_name = repository
    if registry != "registry-1.docker.io":
        public_name = f"{registry}/{repository}"
    return f"{public_name}@{digest}"


def _scaled(value: float, specific: float | None, general: float) -> int:
    return math.ceil(value * (specific if specific is not None else general))


def _task_definition(path: Path) -> TaskDefinitionConfig:
    definition = TaskDefinitionConfig.model_validate_toml(
        (path / "task.toml").read_text()
    )
    if definition.steps:
        raise RuntimeError(
            "multi-step Harbor tasks are not supported by this deployment"
        )
    if definition.environment.os.value != "linux":
        raise RuntimeError(
            "non-Linux Harbor tasks are not supported by this deployment"
        )
    if not definition.environment.docker_image:
        raise RuntimeError("HF Job execution requires a prebuilt task image")
    verifier_environment = definition.verifier.environment
    if (
        verifier_environment is not None
        and verifier_environment.docker_image is not None
        and verifier_environment.docker_image != definition.environment.docker_image
    ):
        raise RuntimeError(
            "direct HF Job execution cannot use a separate verifier image"
        )
    return definition


def _source_name(lock: TrialLock) -> str:
    return lock.task.name.rsplit("/", 1)[-1]


def _execution_trial_lock(
    lock: TrialLock,
    max_command_seconds: int,
    max_image_bytes: int,
    max_image_entries: int,
    declared_task_image: str,
    task_image: str,
) -> TrialLock:
    environment = EnvironmentConfig.model_validate(
        {
            **lock.environment.model_dump(mode="json"),
            "import_path": (
                "harbor_hf_agents.support.control_job_environment:ControlJobEnvironment"
            ),
            "type": None,
            "delete": True,
            "kwargs": {
                "control_max_command_seconds": max_command_seconds,
                "control_max_transfer_bytes": _MAX_TRANSFER_BYTES,
                "control_max_transfer_file_bytes": _MAX_TRANSFER_FILE_BYTES,
                "control_max_transfer_files": _MAX_TRANSFER_FILES,
                "control_max_transfer_path_depth": _MAX_TRANSFER_PATH_DEPTH,
                "control_max_image_bytes": max_image_bytes,
                "control_max_image_entries": max_image_entries,
                "control_declared_task_image": declared_task_image,
                "control_task_image": task_image,
            },
        }
    )
    return lock.model_copy(update={"environment": environment}, deep=True)


def _trial_body(
    expected: ExpectedTask,
    harbor_lock: TrialLock,
    definition: TaskDefinitionConfig,
    image: str,
    template: dict[str, Any],
) -> tuple[TrialLock, dict[str, Any]]:
    environment = definition.environment
    agent_base = definition.agent.timeout_sec
    if agent_base is None:
        raise RuntimeError("HF Job execution requires a bounded agent timeout")
    setup_base = harbor_lock.agent.override_setup_timeout_sec or 360.0
    phase_timeouts = {
        "agent_timeout_seconds": _scaled(
            agent_base,
            harbor_lock.agent_timeout_multiplier,
            harbor_lock.timeout_multiplier,
        ),
        "verifier_timeout_seconds": _scaled(
            definition.verifier.timeout_sec,
            harbor_lock.verifier_timeout_multiplier,
            harbor_lock.timeout_multiplier,
        ),
        "environment_build_timeout_seconds": _scaled(
            environment.build_timeout_sec,
            harbor_lock.environment_build_timeout_multiplier,
            harbor_lock.timeout_multiplier,
        ),
        "agent_setup_timeout_seconds": _scaled(
            setup_base,
            harbor_lock.agent_setup_timeout_multiplier,
            harbor_lock.timeout_multiplier,
        ),
    }
    max_command_seconds = max(phase_timeouts.values())
    prepared_lock = _execution_trial_lock(
        harbor_lock,
        max_command_seconds,
        int(template["max_image_bytes"]),
        int(template["max_image_entries"]),
        str(environment.docker_image),
        image,
    )
    trial_lock = prepared_lock.model_dump(mode="json")
    return prepared_lock, {
        "phase": "trial",
        "task_id": expected.task_id,
        "source_task_id": expected.source_task_id,
        "trial_index": expected.trial_index,
        "input_digest": expected.input_digest,
        "trial_lock": trial_lock,
        "trial_lock_digest": digest_json(trial_lock),
        "declared_image": str(environment.docker_image),
        "image": image,
        "cpus": environment.cpus or int(template["default_cpus"]),
        "memory_mb": environment.memory_mb or int(template["default_memory_mb"]),
        "storage_mb": environment.storage_mb or int(template["default_storage_mb"]),
        "gpus": (
            environment.gpus
            if environment.gpus is not None
            else int(template["default_gpus"])
        ),
        **phase_timeouts,
    }


def _submit(client: ControlClient, body: dict[str, Any], key: str) -> dict[str, Any]:
    return client.request_sync(
        "POST",
        f"/api/v1/runs/{client.run_id}/prepared-job",
        body=body,
        idempotency_key=key,
        timeout_seconds=120,
    )


def _preparation_input(
    lock: dict[str, Any],
) -> tuple[str, tuple[ExpectedTask, ...], dict[str, Any], JobConfig]:
    run_id = str(lock["run_id"])
    deployment = run_lock_profile(lock, "deployment")
    if version("harbor") != deployment["harbor_version"]:
        raise RuntimeError(
            "installed Harbor version does not match the deployment profile"
        )
    if _required("HARBOR_HF_WORKER_REVISION") != deployment["worker_revision"]:
        raise RuntimeError(
            "preparation worker revision does not match the deployment profile"
        )
    template = deployment["trial_job_template"]
    if not isinstance(template, dict):
        raise RuntimeError("deployment has no trial Job template")
    return run_id, _expected_tasks(lock), template, _job_config(lock)


async def _prepare(lock: dict[str, Any]) -> None:
    run_id, expected, template, config = _preparation_input(lock)
    plan = await JobPlan.from_config(
        config,
        job_id=uuid5(NAMESPACE_URL, f"harbor-hf:{run_id}"),
    )
    if len(plan.job_lock.trials) != len(expected):
        raise RuntimeError("resolved Harbor trial count does not match the run")
    client = ControlClient.from_environment()
    if client.run_id != run_id:
        raise RuntimeError("prepared run does not match its control client")
    prepared_locks: list[TrialLock] = []
    seen: dict[str, int] = {}
    definitions: dict[Path, TaskDefinitionConfig] = {}
    images: dict[str, str] = {}
    for expected_task, trial_config, harbor_lock in zip(
        expected,
        plan.trial_configs,
        plan.job_lock.trials,
        strict=True,
    ):
        source_name = _source_name(harbor_lock)
        seen.setdefault(source_name, 0)
        seen[source_name] += 1
        if (
            source_name != expected_task.source_task_id
            or seen[source_name] != expected_task.trial_index
            or harbor_lock.task.digest != expected_task.input_digest
        ):
            raise RuntimeError("resolved Harbor task does not match the run lock")
        download = plan.task_download_results[trial_config.task.get_task_id()]
        if download.path not in definitions:
            definitions[download.path] = _task_definition(download.path)
        definition = definitions[download.path]
        declared_image = str(definition.environment.docker_image)
        if declared_image not in images:
            images[declared_image] = _locked_image(declared_image)
        prepared_lock, body = _trial_body(
            expected_task,
            harbor_lock,
            definition,
            images[declared_image],
            template,
        )
        _submit(
            client,
            body,
            f"prepare-trial-{_required('HARBOR_HF_ACTION_ID')}-{expected_task.task_id}",
        )
        prepared_locks.append(prepared_lock)
    created_at = datetime.fromisoformat(str(lock["created_at"]).replace("Z", "+00:00"))
    prepared_job_lock = plan.job_lock.model_copy(
        update={"created_at": created_at, "trials": prepared_locks},
        deep=True,
    )
    lock_json = prepared_job_lock.model_dump(mode="json")
    header = {key: value for key, value in lock_json.items() if key != "trials"}
    config_json = config.model_dump(mode="json")
    _submit(
        client,
        {
            "phase": "finalize",
            "harbor_version": version("harbor"),
            "job_config": config_json,
            "job_lock_header": header,
        },
        f"prepare-finalize-{_required('HARBOR_HF_ACTION_ID')}",
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if _required("HARBOR_HF_WORKER_ROLE") != "preparation":
        raise RuntimeError("preparation worker role is invalid")
    if any(
        name in os.environ and os.environ[name]
        for name in ("HF_TOKEN", "HF_INFERENCE_TOKEN")
    ):
        raise RuntimeError("preparation worker must not receive persistent credentials")
    run_id = _required("HARBOR_HF_RUN_ID")
    _LOGGER.info(
        "Starting Harbor preparation for run %s with action %s",
        run_id,
        _required("HARBOR_HF_ACTION_ID"),
    )
    lock = _read_run_lock(run_id)
    asyncio.run(_prepare(lock))
    tasks = lock["tasks"]
    if not isinstance(tasks, list):
        raise RuntimeError("run lock tasks must be a list")
    _LOGGER.info(
        "Prepared %d Harbor trials for run %s",
        len(tasks),
        run_id,
    )


if __name__ == "__main__":
    main()

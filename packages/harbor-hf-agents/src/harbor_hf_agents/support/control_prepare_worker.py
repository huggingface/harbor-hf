"""Resolve a Harbor job and submit its immutable trial locks."""

from __future__ import annotations

import asyncio
import copy
import json
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

from harbor_hf_agents.support.control_sandbox_environment import _ControlClient

_ACCEPT_MANIFESTS = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)
_BEARER_PARAMETER = re.compile(r'(\w+)="([^"]*)"')


@dataclass(frozen=True)
class ExpectedTask:
    task_id: str
    source_task_id: str
    trial_index: int
    input_digest: str


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required preparation worker setting {name} is missing")
    return value


def _profile(lock: dict[str, Any], kind: str) -> dict[str, Any]:
    matches = [item for item in lock.get("profiles", []) if item.get("kind") == kind]
    if len(matches) != 1 or not isinstance(matches[0].get("spec"), dict):
        raise RuntimeError(f"campaign lock must contain one {kind} profile")
    return matches[0]["spec"]


def _read_campaign_lock(campaign_id: str) -> dict[str, Any]:
    return _ControlClient(campaign_id, "preparation").request(
        "GET",
        f"/api/v1/campaigns/{campaign_id}/lock",
        idempotency_key=f"prepare-lock-{_required('HARBOR_HF_ACTION_ID')}",
        timeout=60.0,
    )


def _expected_tasks(lock: dict[str, Any]) -> tuple[ExpectedTask, ...]:
    output: list[ExpectedTask] = []
    for value in lock.get("tasks", []):
        if not isinstance(value, dict):
            raise RuntimeError("campaign task lock must be an object")
        output.append(
            ExpectedTask(
                task_id=str(value["task_id"]),
                source_task_id=str(value["source_task_id"]),
                trial_index=int(value["trial_index"]),
                input_digest=str(value["input_digest"]),
            )
        )
    if not output:
        raise RuntimeError("campaign must contain at least one task")
    if len({item.task_id for item in output}) != len(output):
        raise RuntimeError("campaign task IDs must be unique")
    if len({(item.source_task_id, item.trial_index) for item in output}) != len(output):
        raise RuntimeError("campaign source task trials must be unique")
    return tuple(output)


def _job_config(lock: dict[str, Any]) -> JobConfig:
    benchmark = _profile(lock, "benchmark")
    model = _profile(lock, "model")
    harness = _profile(lock, "harness")
    deployment = _profile(lock, "deployment")
    raw_job = benchmark.get("harbor_job")
    raw_agent = harness.get("harbor_agent")
    if not isinstance(raw_job, dict) or not isinstance(raw_agent, dict):
        raise RuntimeError("prepared campaign profiles must contain Harbor job data")
    if deployment.get("preparation") != "required":
        raise RuntimeError("deployment does not require Harbor preparation")
    for key in ("agents", "environment", "retry", "job_name", "jobs_dir"):
        if key in raw_job:
            raise RuntimeError(f"benchmark Harbor job cannot set control field {key}")
    agent = copy.deepcopy(raw_agent)
    if agent.get("model_name") != model.get("harbor_model_name"):
        raise RuntimeError("Harbor agent model does not match the model profile")
    value = copy.deepcopy(raw_job)
    value.update(
        {
            "job_name": f"prepare-{lock['campaign_id']}",
            "jobs_dir": "/tmp/harbor-hf-prepared-jobs",
            "agents": [agent],
            "environment": {
                "import_path": (
                    "harbor_hf_agents.support.control_sandbox_environment:"
                    "ControlSandboxEnvironment"
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
    token = payload.get("token") or payload.get("access_token")
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
        token = _bearer_token(error.headers.get("WWW-Authenticate", ""))
        headers["Authorization"] = f"Bearer {token}"
        response = urlopen(  # noqa: S310 -- reviewed HTTPS registry URL
            Request(url, method="HEAD", headers=headers),
            timeout=30,
        )
    with response:
        digest = response.headers.get("Docker-Content-Digest")
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
        raise RuntimeError("HF Sandbox execution requires a prebuilt task image")
    return definition


def _source_name(lock: TrialLock) -> str:
    return lock.task.name.rsplit("/", 1)[-1]


def _execution_trial_lock(lock: TrialLock, task_id: str) -> TrialLock:
    environment = EnvironmentConfig.model_validate(
        {
            **lock.environment.model_dump(mode="json"),
            "import_path": (
                "harbor_hf_agents.support.control_sandbox_environment:"
                "ControlSandboxEnvironment"
            ),
            "type": None,
            "delete": True,
            "kwargs": {"control_task_id": task_id},
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
        raise RuntimeError("HF Sandbox execution requires a bounded agent timeout")
    setup_base = harbor_lock.agent.override_setup_timeout_sec or 360.0
    prepared_lock = _execution_trial_lock(harbor_lock, expected.task_id)
    return prepared_lock, {
        "phase": "trial",
        "task_id": expected.task_id,
        "source_task_id": expected.source_task_id,
        "trial_index": expected.trial_index,
        "input_digest": expected.input_digest,
        "trial_lock": prepared_lock.model_dump(mode="json"),
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


def _submit(client: _ControlClient, body: dict[str, Any], key: str) -> dict[str, Any]:
    return client.request(
        "POST",
        f"/api/v1/campaigns/{client.campaign_id}/prepared-job",
        body=body,
        idempotency_key=key,
        timeout=120.0,
    )


def _preparation_input(
    lock: dict[str, Any],
) -> tuple[str, tuple[ExpectedTask, ...], dict[str, Any], JobConfig]:
    campaign_id = str(lock["campaign_id"])
    deployment = _profile(lock, "deployment")
    if version("harbor") != deployment.get("harbor_version"):
        raise RuntimeError(
            "installed Harbor version does not match the deployment profile"
        )
    if _required("HARBOR_HF_WORKER_REVISION") != deployment.get("worker_revision"):
        raise RuntimeError(
            "preparation worker revision does not match the deployment profile"
        )
    template = deployment.get("sandbox_template")
    if not isinstance(template, dict):
        raise RuntimeError("deployment has no Sandbox template")
    return campaign_id, _expected_tasks(lock), template, _job_config(lock)


async def _prepare(lock: dict[str, Any]) -> None:
    campaign_id, expected, template, config = _preparation_input(lock)
    plan = await JobPlan.from_config(
        config,
        job_id=uuid5(NAMESPACE_URL, f"harbor-hf:{campaign_id}"),
    )
    if len(plan.job_lock.trials) != len(expected):
        raise RuntimeError("resolved Harbor trial count does not match the campaign")
    client = _ControlClient(campaign_id, "preparation")
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
        seen[source_name] = seen.get(source_name, 0) + 1
        if (
            source_name != expected_task.source_task_id
            or seen[source_name] != expected_task.trial_index
            or harbor_lock.task.digest != expected_task.input_digest
        ):
            raise RuntimeError("resolved Harbor task does not match the campaign lock")
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
    if _required("HARBOR_HF_WORKER_ROLE") != "preparation":
        raise RuntimeError("preparation worker role is invalid")
    if os.environ.get("HF_TOKEN") or os.environ.get("HF_INFERENCE_TOKEN"):
        raise RuntimeError("preparation worker must not receive persistent credentials")
    campaign_id = _required("HARBOR_HF_CAMPAIGN_ID")
    lock = _read_campaign_lock(campaign_id)
    asyncio.run(_prepare(lock))
    print(
        json.dumps(
            {
                "status": "prepared",
                "campaign_id": campaign_id,
                "task_count": len(lock.get("tasks", [])),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

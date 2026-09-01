"""Run one locked Harbor trial and submit its evidence."""

from __future__ import annotations

import base64
import codecs
import copy
import json
import logging
import math
import os
import re
import signal
import stat
import subprocess
import tarfile
import tempfile
import threading
from collections import deque
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any
from urllib.parse import quote

from harbor.models.job.config import JobConfig
from harbor.models.job.lock import TrialLock
from harbor.models.trial.config import AgentConfig

from harbor_hf_agents.support.control_client import (
    ControlClient,
    ControlClientError,
    ControlClientTransientError,
    digest_bytes,
    digest_json,
)
from harbor_hf_agents.support.control_job_environment import (
    ControlJobEnvironment,
    JobEnvironmentPreflightError,
)
from harbor_hf_agents.support.hf_inference_bridge import (
    InferenceUsage,
    InferenceUsageError,
    read_job_inference_usage,
)
from harbor_hf_agents.support.provider_outcome import (
    ProviderPolicyError,
    TerminalProviderError,
    TransientProviderError,
)

_LOGGER = logging.getLogger(__name__)
_EVIDENCE_CHUNK_BYTES = 8 * 1024 * 1024
_MAX_HARBOR_OUTPUT_BYTES = 1_000_000
_MAX_JSON_BYTES = 16 * 1024 * 1024
_MAX_EVIDENCE_FILE_BYTES = 512 * 1024 * 1024
_MAX_EVIDENCE_TOTAL_BYTES = 1024 * 1024 * 1024
_MAX_EVIDENCE_ARCHIVE_BYTES = 1024 * 1024 * 1024
_MAX_EVIDENCE_ENTRIES = 10_000
_LOG_READ_BYTES = 8 * 1024
_LOG_DRAIN_SECONDS = 5
_MAX_SENSITIVE_OUTPUT_CHARS = 4 * 1024
_OUTPUT_TRUNCATION_NOTICE = b"\n[harbor-hf: output truncated]\n"
_SENSITIVE_OUTPUT_ENVIRONMENT = (
    "HARBOR_HF_WORKER_CAPABILITY",
    "HF_INFERENCE_TOKEN",
    "HF_TOKEN",
)
_HARBOR_CHILD_ENVIRONMENT = frozenset(
    {
        "ALL_PROXY",
        "CURL_CA_BUNDLE",
        "HARBOR_HF_ACTION_ID",
        "HARBOR_HF_AGENT_TIMEOUT_SECONDS",
        "HARBOR_HF_CONTROL_URL",
        "HARBOR_HF_JOB_IMAGE",
        "HARBOR_HF_MAX_IMAGE_BYTES",
        "HARBOR_HF_MAX_IMAGE_ENTRIES",
        "HARBOR_HF_PREPARED_JOB_DIGEST",
        "HARBOR_HF_RUN_ID",
        "HARBOR_HF_RUN_LOCK_DIGEST",
        "HARBOR_HF_TASK_IDS_JSON",
        "HARBOR_HF_TASK_IMAGE",
        "HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY",
        "HARBOR_HF_WORKER_CAPABILITY",
        "HARBOR_HF_WORKER_REVISION",
        "HARBOR_HF_WORKER_ROLE",
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LD_LIBRARY_PATH",
        "NO_PROXY",
        "PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "REQUESTS_CA_BUNDLE",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "VIRTUAL_ENV",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
)
_POLICY_FAILURES = {
    "AgentAuthenticationError",
    "ApiUsageLimitError",
    "ModelNotFoundError",
}
_ENVIRONMENT_SETUP_ERRORS = {
    "AddTestsDirError",
    "DownloadEnvironmentDirError",
    "DownloadVerifierDirError",
    "JobEnvironmentPreflightError",
}


class PreparedDataError(RuntimeError):
    """Raised when immutable prepared data fails worker-side validation."""


class WorkerEvidenceError(RuntimeError):
    """Raised when task-controlled evidence violates worker limits or integrity."""


class MissingHarborResultError(RuntimeError):
    """Raised when Harbor exits without its required trial result."""

    def __init__(self, message: str, *, timed_out: bool = False) -> None:
        super().__init__(message)
        self.timed_out = timed_out


@dataclass(frozen=True)
class LockedTask:
    """One prepared physical Harbor trial assigned to this HF Job."""

    task_id: str
    source_task_id: str
    trial_index: int
    input_digest: str
    image: str
    agent_timeout_seconds: int
    timeout_seconds: int
    trial_lock: TrialLock


@dataclass(frozen=True)
class WorkerConfig:
    """Immutable settings needed to execute one assigned trial."""

    run_id: str
    action_id: str
    historical: bool
    harbor_version: str
    worker_revision: str
    input_price: int
    output_price: int
    harbor_agent: dict[str, Any]
    job_config: dict[str, Any]
    task: LockedTask


@dataclass(frozen=True)
class WorkerIdentity:
    """Capability-scoped identity available before prepared data is trusted."""

    run_id: str
    action_id: str
    task_id: str


def _required(name: str) -> str:
    try:
        value = os.environ[name]
    except KeyError as error:
        raise RuntimeError(
            f"required control worker setting {name} is missing"
        ) from error
    if not value:
        raise RuntimeError(f"required control worker setting {name} is empty")
    return value


def _required_positive_integer(name: str) -> int:
    value = _required(name)
    if re.fullmatch(r"[1-9][0-9]*", value) is None:
        raise RuntimeError(f"required control worker setting {name} is invalid")
    return int(value)


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        + "\n"
    ).encode()


def _control_client(run_id: str) -> ControlClient:
    client = ControlClient.from_environment()
    if client.run_id != run_id:
        raise RuntimeError("worker run does not match its control client")
    return client


def _read_lock(run_id: str) -> dict[str, Any]:
    return _control_client(run_id).request_sync(
        "GET",
        f"/api/v1/runs/{quote(run_id, safe='')}/lock",
        idempotency_key=f"control-worker-lock-{_required('HARBOR_HF_ACTION_ID')}",
    )


def _read_execution(lock: dict[str, Any], run_id: str) -> dict[str, Any]:
    """Read the immutable execution bound to a current or continued Run."""
    if "execution" in lock:
        execution = lock["execution"]
        if (
            "HARBOR_HF_RUN_CONTINUATION_REPAIR_ID" in os.environ
            or "HARBOR_HF_RUN_CONTINUATION_REPAIR_SUCCESSOR_ID" in os.environ
        ):
            raise PreparedDataError(
                "current run cannot carry a continuation worker repair"
            )
    else:
        execution = _read_historical_execution(run_id)
    if not isinstance(execution, dict) or execution["contract_version"] != "v1":
        raise PreparedDataError("run execution contract is invalid")
    return execution


def _read_historical_execution(run_id: str) -> dict[str, Any]:
    """Read a historical continuation and its complete worker repair chain."""
    continuation = _control_client(run_id).request_sync(
        "GET",
        f"/api/v1/runs/{quote(run_id, safe='')}/continuation",
        idempotency_key=(
            f"control-worker-continuation-{_required('HARBOR_HF_ACTION_ID')}"
        ),
    )
    try:
        continuation_record_id = continuation["record_id"]
        continuation_run_id = continuation["run_id"]
        continuation_lock_digest = continuation["run_lock_digest"]
        execution = continuation["execution"]
    except KeyError as error:
        raise PreparedDataError(
            "run continuation is missing its immutable execution binding"
        ) from error
    if continuation_run_id != run_id or continuation_lock_digest != _required(
        "HARBOR_HF_RUN_LOCK_DIGEST"
    ):
        raise PreparedDataError(
            "run continuation does not match the worker capability"
        ) from None
    repair_id = os.environ.get("HARBOR_HF_RUN_CONTINUATION_REPAIR_ID")
    successor_id = os.environ.get("HARBOR_HF_RUN_CONTINUATION_REPAIR_SUCCESSOR_ID")
    if repair_id:
        execution, repair = _apply_continuation_repair(
            run_id,
            continuation,
            continuation_record_id,
            execution,
            repair_id,
        )
        if successor_id:
            execution = _apply_continuation_repair_successor(
                run_id,
                continuation,
                continuation_record_id,
                repair,
                execution,
                successor_id,
            )
    elif successor_id:
        raise PreparedDataError(
            "continuation worker repair successor has no prior repair"
        )
    return execution


def _apply_continuation_repair(
    run_id: str,
    continuation: dict[str, Any],
    continuation_record_id: object,
    execution: dict[str, Any],
    repair_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Apply the capability-bound worker repair to a historical execution."""
    repair = _control_client(run_id).request_sync(
        "GET",
        f"/api/v1/runs/{quote(run_id, safe='')}/continuation-repair",
        idempotency_key=(
            f"control-worker-continuation-repair-{_required('HARBOR_HF_ACTION_ID')}"
        ),
    )
    required_fields = (
        "record_id",
        "run_id",
        "run_lock_digest",
        "run_continuation_id",
        "run_continuation_digest",
        "job_image",
        "worker_revision",
    )
    try:
        values = tuple(repair[field] for field in required_fields)
    except KeyError as error:
        raise PreparedDataError(
            "run continuation repair is missing its immutable binding"
        ) from error
    expected = (
        repair_id,
        run_id,
        _required("HARBOR_HF_RUN_LOCK_DIGEST"),
        continuation_record_id,
        digest_bytes(_canonical_json(continuation)),
    )
    if values[:5] != expected:
        raise PreparedDataError(
            "run continuation repair does not match the worker capability"
        )
    if not isinstance(values[5], str) or not isinstance(values[6], str):
        raise PreparedDataError("run continuation repair worker fields are invalid")
    repaired = copy.deepcopy(execution)
    deployment = copy.deepcopy(repaired["deployment"])
    deployment["job_image"], deployment["worker_revision"] = values[5:]
    repaired["deployment"] = deployment
    return repaired, repair


def _apply_continuation_repair_successor(
    run_id: str,
    continuation: dict[str, Any],
    continuation_record_id: object,
    repair: dict[str, Any],
    execution: dict[str, Any],
    successor_id: str,
) -> dict[str, Any]:
    """Apply one capability-bound successor to a continuation worker repair."""
    successor = _control_client(run_id).request_sync(
        "GET",
        f"/api/v1/runs/{quote(run_id, safe='')}/continuation-repair-successor",
        idempotency_key=(
            "control-worker-continuation-repair-successor-"
            f"{_required('HARBOR_HF_ACTION_ID')}"
        ),
    )
    required_fields = (
        "record_id",
        "run_id",
        "run_lock_digest",
        "run_continuation_id",
        "run_continuation_digest",
        "run_continuation_repair_id",
        "run_continuation_repair_digest",
        "job_image",
        "worker_revision",
    )
    try:
        values = tuple(successor[field] for field in required_fields)
        repair_id = repair["record_id"]
    except KeyError as error:
        raise PreparedDataError(
            "run continuation repair successor is missing its immutable binding"
        ) from error
    expected = (
        successor_id,
        run_id,
        _required("HARBOR_HF_RUN_LOCK_DIGEST"),
        continuation_record_id,
        digest_bytes(_canonical_json(continuation)),
        repair_id,
        digest_bytes(_canonical_json(repair)),
    )
    if values[:7] != expected:
        raise PreparedDataError(
            "run continuation repair successor does not match the worker capability"
        )
    if not isinstance(values[7], str) or not isinstance(values[8], str):
        raise PreparedDataError(
            "run continuation repair successor worker fields are invalid"
        )
    repaired = copy.deepcopy(execution)
    deployment = copy.deepcopy(repaired["deployment"])
    deployment["job_image"], deployment["worker_revision"] = values[7:]
    repaired["deployment"] = deployment
    return repaired


def _read_prepared_job(run_id: str) -> dict[str, Any]:
    return _control_client(run_id).request_sync(
        "GET",
        f"/api/v1/runs/{quote(run_id, safe='')}/prepared-job",
        idempotency_key=f"prepared-job-{_required('HARBOR_HF_ACTION_ID')}",
    )


def _read_prepared_trial(run_id: str, task_id: str) -> dict[str, Any]:
    return _control_client(run_id).request_sync(
        "GET",
        (
            f"/api/v1/runs/{quote(run_id, safe='')}/prepared-job/trials/"
            f"{quote(task_id, safe='')}"
        ),
        idempotency_key=(
            f"prepared-trial-{_required('HARBOR_HF_ACTION_ID')}-{task_id}"
        ),
    )


def _assigned_task_id() -> str:
    value = json.loads(_required("HARBOR_HF_TASK_IDS_JSON"))
    if (
        not isinstance(value, list)
        or len(value) != 1
        or not isinstance(value[0], str)
        or not value[0]
    ):
        raise RuntimeError("execution Job requires exactly one assigned task ID")
    return value[0]


def _worker_identity() -> WorkerIdentity:
    """Return the action and task identity assigned by the control service."""
    return WorkerIdentity(
        run_id=_required("HARBOR_HF_RUN_ID"),
        action_id=_required("HARBOR_HF_ACTION_ID"),
        task_id=_assigned_task_id(),
    )


def _image_repository(image: str) -> str:
    """Normalize an OCI image reference to its registry and repository."""
    without_digest = image.split("@", 1)[0]
    first, slash, rest = without_digest.partition("/")
    if slash and ("." in first or ":" in first or first == "localhost"):
        registry = "registry-1.docker.io" if first == "docker.io" else first
        repository = rest
    else:
        registry = "registry-1.docker.io"
        repository = without_digest
    tail = repository.rsplit("/", 1)[-1]
    if ":" in tail:
        repository = repository.rsplit(":", 1)[0]
    if registry == "registry-1.docker.io" and "/" not in repository:
        repository = f"library/{repository}"
    return (
        repository if registry == "registry-1.docker.io" else f"{registry}/{repository}"
    )


def _validate_prepared_image(value: dict[str, Any]) -> str:
    image = str(value["image"])
    declared_image = str(value["declared_image"])
    if re.fullmatch(r".+@sha256:[0-9a-f]{64}", image) is None:
        raise PreparedDataError("prepared trial image is not digest-pinned")
    if _image_repository(image) != _image_repository(declared_image):
        raise PreparedDataError("prepared trial image repository does not match")
    if image != _required("HARBOR_HF_TASK_IMAGE"):
        raise PreparedDataError("prepared trial image does not match the launch action")
    return image


def _locked_config(  # noqa: C901 -- immutable binding validation is explicit
    lock: dict[str, Any],
) -> WorkerConfig:
    """Validate immutable records and build the assigned worker configuration."""
    identity = _worker_identity()
    run_id = identity.run_id
    if lock["run_id"] != run_id:
        raise PreparedDataError("run lock identity does not match worker environment")
    historical = "execution" not in lock
    execution = _read_execution(lock, run_id)
    try:
        deployment = execution["deployment"]
        harbor_agent = execution["harbor_agent"]
    except KeyError as error:
        raise PreparedDataError("prepared execution contract is incomplete") from error
    if not isinstance(deployment, dict) or not isinstance(harbor_agent, dict):
        raise PreparedDataError("prepared execution contract is invalid")
    if deployment["route"] != "hf_job" or deployment["preparation"] != "required":
        raise PreparedDataError("control worker requires a prepared HF Job deployment")
    worker_image = str(deployment["job_image"])
    if re.fullmatch(r".+@sha256:[0-9a-f]{64}", worker_image) is None:
        raise PreparedDataError("deployment worker image is not digest-pinned")
    if worker_image != _required("HARBOR_HF_JOB_IMAGE"):
        raise PreparedDataError("physical Job image does not match the deployment")

    task_id = identity.task_id
    prepared = _read_prepared_job(run_id)
    run_lock_digest = _required("HARBOR_HF_RUN_LOCK_DIGEST")
    if prepared["run_id"] != run_id or prepared["run_lock_digest"] != run_lock_digest:
        raise PreparedDataError("prepared Job binding does not match the run lock")
    prepared_trials = prepared["trials"]
    run_tasks = lock["tasks"]
    if not isinstance(prepared_trials, list) or not isinstance(run_tasks, list):
        raise PreparedDataError("prepared Job and run tasks must be lists")
    expected_tasks = {
        item["task_id"]: item
        for item in run_tasks
        if isinstance(item, dict) and isinstance(item["task_id"], str)
    }
    if len(expected_tasks) != len(run_tasks):
        raise PreparedDataError("run task assignments are invalid or duplicated")
    if not all(
        isinstance(item, dict)
        and isinstance(item["task_id"], str)
        and isinstance(item["record_id"], str)
        and isinstance(item["record_digest"], str)
        for item in prepared_trials
    ):
        raise PreparedDataError("prepared trial references are invalid")
    references = {item["task_id"]: item for item in prepared_trials}
    if len(references) != len(prepared_trials):
        raise PreparedDataError("prepared trial references are duplicated")
    if list(references) != list(expected_tasks):
        raise PreparedDataError("prepared trial order does not match the run lock")
    if task_id not in references:
        raise PreparedDataError("worker task assignment is outside the prepared job")

    # The capability-authenticated control service verifies complete record
    # digests. Recomputing JavaScript records here would change valid JSON
    # numbers whose Python and JavaScript spellings differ.
    reference = references[task_id]
    value = _read_prepared_trial(run_id, task_id)
    expected = expected_tasks[task_id]
    if (
        value["record_id"] != reference["record_id"]
        or value["run_id"] != run_id
        or value["preparation_id"] != prepared["preparation_id"]
        or value["run_lock_digest"] != run_lock_digest
        or value["task_id"] != task_id
        or value["input_digest"] != expected["input_digest"]
        or value["source_task_id"] != expected["source_task_id"]
        or value["trial_index"] != expected["trial_index"]
    ):
        raise PreparedDataError("prepared trial does not match the run lock")
    harbor_lock = TrialLock.model_validate(value["trial_lock"])
    # JavaScript JSON round trips render an integral Python float such as 1.0
    # as 1. Restore Harbor's typed representation before checking its digest.
    normalized_trial_lock = harbor_lock.model_dump(mode="json", exclude_unset=True)
    if digest_json(normalized_trial_lock) != value["trial_lock_digest"]:
        raise PreparedDataError(
            f"prepared Harbor trial lock digest does not match: {task_id}"
        )
    if harbor_lock.task.digest != value["input_digest"]:
        raise PreparedDataError("prepared Harbor task digest does not match")
    task_image = _validate_prepared_image(value)
    environment_kwargs = harbor_lock.environment.kwargs
    _required("HARBOR_HF_TASK_IMAGE_MIRROR_REPOSITORY")
    if environment_kwargs["control_declared_task_image"] != value["declared_image"]:
        raise PreparedDataError(
            "prepared Harbor environment image does not match its declaration"
        )
    if environment_kwargs["control_task_image"] != task_image:
        raise PreparedDataError(
            "prepared Harbor environment image does not match the locked image"
        )
    image_limits = {
        "control_max_image_bytes": _required_positive_integer(
            "HARBOR_HF_MAX_IMAGE_BYTES"
        ),
        "control_max_image_entries": _required_positive_integer(
            "HARBOR_HF_MAX_IMAGE_ENTRIES"
        ),
    }
    for name, expected_limit in image_limits.items():
        if environment_kwargs[name] != expected_limit:
            raise PreparedDataError(
                f"prepared Harbor environment {name} does not match the launch action"
            )
    if task_image == worker_image:
        raise PreparedDataError(
            "physical Job image cannot be the prepared benchmark task image"
        )
    timeout = sum(
        int(value[name])
        for name in (
            "agent_timeout_seconds",
            "verifier_timeout_seconds",
            "environment_build_timeout_seconds",
            "agent_setup_timeout_seconds",
        )
    )
    job_config = prepared["job_config"]
    if not isinstance(job_config, dict):
        raise PreparedDataError("prepared Harbor job config is invalid")
    return WorkerConfig(
        run_id=run_id,
        action_id=identity.action_id,
        historical=historical,
        harbor_version=str(deployment["harbor_version"]),
        worker_revision=str(deployment["worker_revision"]),
        input_price=int(deployment["input_price_microusd_per_million_tokens"]),
        output_price=int(deployment["output_price_microusd_per_million_tokens"]),
        harbor_agent=copy.deepcopy(harbor_agent),
        job_config=copy.deepcopy(job_config),
        task=LockedTask(
            task_id=task_id,
            source_task_id=str(value["source_task_id"]),
            trial_index=int(value["trial_index"]),
            input_digest=str(value["input_digest"]),
            image=task_image,
            agent_timeout_seconds=int(value["agent_timeout_seconds"]),
            timeout_seconds=timeout,
            trial_lock=harbor_lock,
        ),
    )


def _task_source(task: LockedTask) -> dict[str, Any]:
    """Build the Harbor Run task without a dataset source label."""
    source = task.trial_lock.task
    if source.type == "package":
        return {"name": source.name, "ref": source.digest}
    if source.type == "git":
        if not source.git_url or not source.git_commit_id or source.path is None:
            raise RuntimeError("prepared Git task lock is incomplete")
        path = Path(source.path)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError("prepared Git task path is not portable")
        return {
            "path": path.as_posix(),
            "git_url": source.git_url,
            "git_commit_id": source.git_commit_id,
        }
    raise RuntimeError("prepared local Harbor tasks are not portable")


def _job_config(config: WorkerConfig, root: Path) -> Path:
    task = config.task
    lock = task.trial_lock
    if lock.skills or lock.extra_instructions or lock.extra_docker_compose:
        raise RuntimeError(
            "prepared skills, instructions, and compose overlays are unsupported"
        )
    verifier = lock.verifier.model_dump(mode="json")
    verifier.pop("environment_mode", None)
    agent = copy.deepcopy(config.harbor_agent)
    agent["skills"] = []
    value = copy.deepcopy(config.job_config)
    value.update(
        {
            "job_name": task.task_id,
            "jobs_dir": str(root / "jobs"),
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "retry": {"max_retries": 0},
            "datasets": [],
            "tasks": [_task_source(task)],
            "agents": [agent],
            "environment": lock.environment.model_dump(mode="json"),
            "verifier": verifier,
            "timeout_multiplier": lock.timeout_multiplier,
            "agent_timeout_multiplier": lock.agent_timeout_multiplier,
            "verifier_timeout_multiplier": lock.verifier_timeout_multiplier,
            "agent_setup_timeout_multiplier": lock.agent_setup_timeout_multiplier,
            "environment_build_timeout_multiplier": (
                lock.environment_build_timeout_multiplier
            ),
            "extra_instruction_paths": [],
        }
    )
    validated = JobConfig.model_validate(value)
    if (
        validated.n_attempts != 1
        or validated.n_concurrent_trials != 1
        or validated.retry.max_retries != 0
    ):
        raise PreparedDataError(
            "Harbor execution must contain one trial and no retries"
        )
    path = root / "config.json"
    path.write_text(
        json.dumps(validated.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return path


def _result_path(root: Path, task: LockedTask) -> Path | None:
    task_root = root / "jobs" / task.task_id
    try:
        files = _regular_trial_files(task_root)
    except FileNotFoundError:
        return None
    matches = [
        path
        for path in files
        if path.name == "result.json" and path.parent.parent == task_root
    ]
    if len(matches) > 1:
        raise WorkerEvidenceError("Harbor wrote multiple trial results")
    return matches[0] if len(matches) == 1 else None


def _exception_outcome(  # noqa: C901 -- explicit terminal outcome map
    result: dict[str, Any] | None,
    stderr: str,
    *,
    timed_out: bool = False,
) -> tuple[str, bool]:
    if timed_out or "AgentTimeoutError" in stderr or "VerifierTimeoutError" in stderr:
        return "benchmark_timeout", False
    if result is None:
        if "JobEnvironmentPreflightError" in stderr:
            return "infrastructure", True
        if any(marker in stderr for marker in _POLICY_FAILURES):
            return "policy", False
        return "invalid", False
    exception = result["exception_info"] if "exception_info" in result else None  # noqa: SIM401 -- repository style requires direct dictionary access
    if not exception:
        return "complete", False
    if isinstance(exception, dict):
        name = str(exception["exception_type"]) if "exception_type" in exception else ""
        detail = " ".join(
            str(exception[key]) if key in exception else ""
            for key in ("exception_message", "exception_traceback")
        )
    else:
        name = ""
        detail = ""
    if name in {"AgentTimeoutError", "VerifierTimeoutError"}:
        return "benchmark_timeout", False
    if name == ProviderPolicyError.__name__ or name in _POLICY_FAILURES:
        return "policy", False
    if name == TerminalProviderError.__name__:
        return "agent", False
    if "policy_rejected" in detail:
        return "policy", False
    if (
        name in _ENVIRONMENT_SETUP_ERRORS
        or name == TransientProviderError.__name__
        or not _phase_started(result, "agent_execution")
    ):
        return "infrastructure", True
    if "Verifier" in name or "Reward" in name:
        return "verifier", False
    if "Refusal" in name:
        return "refusal", False
    return "agent", False


def _phase_started(result: dict[str, Any], name: str) -> bool:
    value = result[name] if name in result else None  # noqa: SIM401 -- repository style requires direct dictionary access
    return (
        isinstance(value, dict)
        and "started_at" in value
        and value["started_at"] is not None
    )


def _outcome_with_usage(
    outcome: str,
    replacement_eligible: bool,
    usage: InferenceUsage | None,
) -> tuple[str, bool]:
    """Treat missing trusted provider usage as an infrastructure failure."""
    if (
        usage is not None
        and (usage.requests == 0 or usage.input_tokens == 0)
        and outcome in {"agent", "benchmark_timeout", "complete"}
    ):
        return "infrastructure", True
    return outcome, replacement_eligible


def _failure_fingerprint(
    failure_class: str | None,
    *,
    replacement_eligible: bool,
) -> str | None:
    """Identify a repeatable worker failure without storing private error text."""
    if not replacement_eligible or failure_class is None:
        return None
    return digest_json(
        {
            "schema_version": "v1",
            "kind": "infrastructure.failure",
            "failure_class": failure_class,
            "worker_revision": os.environ.get("HARBOR_HF_WORKER_REVISION", "unknown"),
        }
    )


def _result_failure_class(
    result: dict[str, Any] | None,
    usage: InferenceUsage | None,
) -> str:
    if usage is not None and (usage.requests == 0 or usage.input_tokens == 0):
        return "missing-positive-inference-usage"
    if result is None:
        return "missing-harbor-result"
    exception = result.get("exception_info")
    if isinstance(exception, dict) and exception.get("exception_type"):
        return str(exception["exception_type"])
    if not _phase_started(result, "agent_execution"):
        return "agent-execution-not-started"
    return "unclassified-infrastructure-failure"


def _agent_result(result: dict[str, Any] | None) -> dict[str, Any]:
    if result is None or "agent_result" not in result:
        return {}
    value = result["agent_result"]
    return value if isinstance(value, dict) else {}


def _token_count(agent: dict[str, Any], name: str) -> int:
    value = agent[name] if name in agent else 0  # noqa: SIM401 -- repository style requires direct dictionary access
    return int(value) if value is not None else 0


def _metrics(
    result: dict[str, Any] | None,
    usage: InferenceUsage | None = None,
) -> dict[str, float]:
    if result is None:
        return {}
    metrics: dict[str, float] = {}
    verifier = result["verifier_result"] if "verifier_result" in result else {}  # noqa: SIM401 -- repository style requires direct dictionary access
    rewards = (
        verifier["rewards"]
        if isinstance(verifier, dict) and "rewards" in verifier
        else {}
    )
    if isinstance(rewards, dict):
        for name, value in rewards.items():
            if isinstance(value, (int, float)) and math.isfinite(float(value)):
                metrics[name] = float(value)
    agent = _agent_result(result)
    metrics["input_tokens"] = float(
        usage.input_tokens
        if usage is not None
        else _token_count(agent, "n_input_tokens")
    )
    metrics["output_tokens"] = float(
        usage.output_tokens
        if usage is not None
        else _token_count(agent, "n_output_tokens")
    )
    return metrics


def _cost_microusd(
    config: WorkerConfig,
    result: dict[str, Any] | None,
    usage: InferenceUsage | None = None,
) -> int:
    agent = _agent_result(result)
    input_tokens = (
        usage.input_tokens
        if usage is not None
        else _token_count(agent, "n_input_tokens")
    )
    output_tokens = (
        usage.output_tokens
        if usage is not None
        else _token_count(agent, "n_output_tokens")
    )
    return math.ceil(
        input_tokens * config.input_price / 1_000_000
        + output_tokens * config.output_price / 1_000_000
    )


def _read_bounded_file(path: Path, limit: int, *, label: str) -> bytes:
    """Read one regular file without following links or exceeding *limit*."""
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise WorkerEvidenceError(f"{label} is not a regular file")
    if metadata.st_size > limit:
        raise WorkerEvidenceError(f"{label} exceeds the {limit} byte limit")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            payload = handle.read(limit + 1)
    finally:
        os.close(descriptor)
    if len(payload) > limit:
        raise WorkerEvidenceError(f"{label} exceeds the {limit} byte limit")
    return payload


def _regular_trial_files(  # noqa: C901 -- bounded directory traversal state machine
    root: Path,
) -> list[Path]:
    """Return bounded regular evidence files without traversing symlinks."""
    root_metadata = root.lstat()
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise WorkerEvidenceError("trial evidence root is not a regular directory")
    files: list[Path] = []
    pending = [root]
    total_bytes = 0
    entries_seen = 0
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                entries_seen += 1
                if entries_seen > _MAX_EVIDENCE_ENTRIES:
                    raise WorkerEvidenceError(
                        "trial evidence exceeds the entry count limit"
                    )
                if entry.is_symlink():
                    raise WorkerEvidenceError(
                        f"trial evidence contains a symbolic link: {entry.path}"
                    )
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    raise WorkerEvidenceError(
                        f"trial evidence contains an unsupported file: {entry.path}"
                    )
                size = entry.stat(follow_symlinks=False).st_size
                if size > _MAX_EVIDENCE_FILE_BYTES:
                    raise WorkerEvidenceError(
                        f"trial evidence file exceeds the size limit: {entry.path}"
                    )
                total_bytes += size
                if total_bytes > _MAX_EVIDENCE_TOTAL_BYTES:
                    raise WorkerEvidenceError(
                        "trial evidence exceeds the aggregate size limit"
                    )
                files.append(Path(entry.path))
    return files


def _contains_bytes(path: Path, needle: bytes) -> bool:
    """Search a bounded regular file without loading it into memory."""
    overlap = b""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            while chunk := handle.read(1024 * 1024):
                value = overlap + chunk
                if needle in value:
                    return True
                overlap = value[-(len(needle) - 1) :] if len(needle) > 1 else b""
    finally:
        os.close(descriptor)
    return False


def _archive_trial(
    root: Path,
    task: LockedTask,
    result_path: Path | None,
    output: str,
) -> Path:
    if result_path is not None:
        _regular_trial_files(result_path.parent)
    evidence_root = root / "evidence"
    evidence_root.mkdir(parents=True, exist_ok=True)
    (evidence_root / "worker-output.txt").write_text(
        output,
        encoding="utf-8",
    )
    metadata = {
        "schema_version": "v1",
        "task_id": task.task_id,
        "source_task_id": task.source_task_id,
        "trial_index": task.trial_index,
        "input_digest": task.input_digest,
        "image": task.image,
        "result_present": result_path is not None,
    }
    (evidence_root / "worker.json").write_bytes(_canonical_json(metadata))
    archive = evidence_root / "trial.tar.gz"
    with tarfile.open(archive, "w:gz") as handle:
        handle.add(evidence_root / "worker.json", arcname="worker.json")
        handle.add(evidence_root / "worker-output.txt", arcname="worker-output.txt")
        if result_path is not None:
            handle.add(result_path.parent, arcname="harbor-trial")
    if archive.stat().st_size > _MAX_EVIDENCE_ARCHIVE_BYTES:
        archive.unlink()
        raise WorkerEvidenceError("trial evidence archive exceeds the size limit")
    return archive


def _config_identity(config: WorkerConfig) -> WorkerIdentity:
    return WorkerIdentity(
        run_id=config.run_id,
        action_id=config.action_id,
        task_id=config.task.task_id,
    )


def _attempt_path(client: ControlClient, task_id: str) -> str:
    return f"{client.prefix}/tasks/{quote(task_id, safe='')}/attempts"


def _upload_object(
    client: ControlClient,
    identity: WorkerIdentity,
    payload: bytes,
    idempotency_key: str,
) -> tuple[str, str]:
    digest = digest_bytes(payload)
    uploaded = client.request_sync(
        "POST",
        _attempt_path(client, identity.task_id),
        body={
            "operation": "upload_evidence",
            "action_id": identity.action_id,
            "digest": digest,
            "content_base64": base64.b64encode(payload).decode(),
        },
        idempotency_key=idempotency_key,
        timeout_seconds=300,
    )
    return digest, str(uploaded["path"])


def _upload_manifest(
    client: ControlClient,
    identity: WorkerIdentity,
    objects: list[dict[str, Any]],
) -> tuple[str, str]:
    manifest_bytes = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "worker.evidence.manifest",
            "run_id": identity.run_id,
            "action_id": identity.action_id,
            "task_id": identity.task_id,
            "objects": objects,
        }
    )
    return _upload_object(
        client,
        identity,
        manifest_bytes,
        f"evidence-manifest-{identity.action_id}-{identity.task_id}",
    )


def _upload_evidence(
    config: WorkerConfig,
    archive: Path,
) -> tuple[str, str]:
    task = config.task
    client = _control_client(config.run_id)
    identity = _config_identity(config)
    objects: list[dict[str, Any]] = []
    with archive.open("rb") as handle:
        index = 0
        while chunk := handle.read(_EVIDENCE_CHUNK_BYTES):
            digest, path = _upload_object(
                client,
                identity,
                chunk,
                f"evidence-{config.action_id}-{task.task_id}-{index:06d}",
            )
            objects.append({"path": path, "digest": digest, "size": len(chunk)})
            index += 1
    index_bytes = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "harbor.trial.chunk-index",
            "run_id": config.run_id,
            "action_id": config.action_id,
            "task_id": task.task_id,
            "archive": "trial.tar.gz",
            "archive_size": archive.stat().st_size,
            "chunks": objects,
        }
    )
    index_digest, index_path = _upload_object(
        client,
        identity,
        index_bytes,
        f"evidence-index-{config.action_id}-{task.task_id}",
    )
    objects.append(
        {"path": index_path, "digest": index_digest, "size": len(index_bytes)}
    )
    return _upload_manifest(client, identity, objects)


def _upload_failure_note(
    identity: WorkerIdentity,
    error: BaseException,
) -> tuple[str, str]:
    """Upload a canonical manifest that references one bounded failure note."""
    client = _control_client(identity.run_id)
    note = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "worker.evidence.upload_failure",
            "task_id": identity.task_id,
            "error": _redact_text(str(error), limit=500),
        }
    )
    note_digest, note_path = _upload_object(
        client,
        identity,
        note,
        f"evidence-failure-{identity.action_id}-{identity.task_id}",
    )
    return _upload_manifest(
        client,
        identity,
        [{"path": note_path, "digest": note_digest, "size": len(note)}],
    )


def _submit_attempt(
    config: WorkerConfig,
    result: dict[str, Any] | None,
    output: str,
    evidence_digest: str,
    evidence_path: str,
    *,
    timed_out: bool = False,
    outcome_override: tuple[str, bool] | None = None,
    failure_class_override: str | None = None,
) -> None:
    task = config.task
    usage = read_job_inference_usage()
    outcome, replacement = outcome_override or _exception_outcome(
        result,
        output,
        timed_out=timed_out,
    )
    outcome, replacement = _outcome_with_usage(outcome, replacement, usage)
    metrics = _metrics(result, usage)
    failure_fingerprint = _failure_fingerprint(
        (
            failure_class_override or _result_failure_class(result, usage)
            if outcome == "infrastructure"
            else None
        ),
        replacement_eligible=replacement,
    )
    client = _control_client(config.run_id)
    client.request_sync(
        "POST",
        _attempt_path(client, task.task_id),
        body={
            "action_id": config.action_id,
            "outcome": outcome,
            "replacement_eligible": replacement,
            **(
                {"failure_fingerprint": failure_fingerprint}
                if failure_fingerprint is not None
                else {}
            ),
            "evidence_digest": evidence_digest,
            "evidence_path": evidence_path,
            "cost_microusd": _cost_microusd(config, result, usage),
            "metrics": metrics,
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "confirmed": True,
        },
        idempotency_key=f"attempt-{config.action_id}-{task.task_id}",
        timeout_seconds=120,
    )


def _submit_failure_attempt(
    identity: WorkerIdentity,
    error: BaseException,
    *,
    outcome: str,
    replacement_eligible: bool,
) -> None:
    """Submit a bounded failure manifest without trusting prepared result data."""
    digest, evidence_path = _upload_failure_note(identity, error)
    failure_fingerprint = _failure_fingerprint(
        type(error).__name__ if outcome == "infrastructure" else None,
        replacement_eligible=replacement_eligible,
    )
    client = _control_client(identity.run_id)
    client.request_sync(
        "POST",
        _attempt_path(client, identity.task_id),
        body={
            "action_id": identity.action_id,
            "outcome": outcome,
            "replacement_eligible": replacement_eligible,
            **(
                {"failure_fingerprint": failure_fingerprint}
                if failure_fingerprint is not None
                else {}
            ),
            "evidence_digest": digest,
            "evidence_path": evidence_path,
            "cost_microusd": 0,
            "metrics": {},
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "confirmed": True,
        },
        idempotency_key=f"attempt-{identity.action_id}-{identity.task_id}",
        timeout_seconds=120,
    )


def _worker_failure_outcome(error: BaseException) -> tuple[str, bool]:
    """Classify only typed transient failures as replacement-eligible."""
    if isinstance(error, MissingHarborResultError):
        if error.timed_out:
            return "benchmark_timeout", False
        return "infrastructure", True
    if isinstance(
        error,
        (
            ControlClientTransientError,
            InferenceUsageError,
            JobEnvironmentPreflightError,
        ),
    ):
        return "infrastructure", True
    if isinstance(error, ProviderPolicyError):
        return "policy", False
    return "invalid", False


def _sensitive_output_environment(
    environment: Mapping[str, str] = os.environ,
) -> tuple[str, ...]:
    bare_names = {
        "ACCESS_KEY",
        "API_KEY",
        "CREDENTIAL",
        "PASSWORD",
        "PRIVATE_KEY",
        "SECRET",
        "TOKEN",
    }
    suffixes = (
        "_ACCESS_KEY",
        "_API_KEY",
        "_CREDENTIAL",
        "_PASSWORD",
        "_PRIVATE_KEY",
        "_SECRET",
        "_TOKEN",
    )
    return tuple(
        name
        for name, value in environment.items()
        if value
        and (
            name in _SENSITIVE_OUTPUT_ENVIRONMENT
            or name.upper() in bare_names
            or name.upper().endswith(suffixes)
        )
    )


def _sensitive_output_values(
    environment: Mapping[str, str] = os.environ,
) -> tuple[str, ...]:
    values = {environment[name] for name in _sensitive_output_environment(environment)}
    if any(len(value) > _MAX_SENSITIVE_OUTPUT_CHARS for value in values):
        raise RuntimeError("sensitive worker setting exceeds the output safety limit")
    return tuple(sorted(values, key=len, reverse=True))


def _redaction_marker(sensitive_values: tuple[str, ...]) -> str:
    for marker in ("<redacted>", "[private]", "***"):
        if all(value not in marker for value in sensitive_values):
            return marker
    return ""


def _redact_pending_output(
    pending: str,
    sensitive_values: tuple[str, ...],
    marker: str,
    *,
    final: bool,
) -> tuple[str, str]:
    redacted: list[str] = []
    while pending:
        matches = [value for value in sensitive_values if pending.startswith(value)]
        longer_prefix = not final and any(
            value.startswith(pending) and len(value) > len(pending)
            for value in sensitive_values
        )
        if matches and not longer_prefix:
            match = matches[0]
            redacted.append(marker)
            pending = pending[len(match) :]
        elif not final and any(value.startswith(pending) for value in sensitive_values):
            break
        else:
            redacted.append(pending[0])
            pending = pending[1:]
    return "".join(redacted), pending


def _redact_text(value: str, *, limit: int) -> str:
    redacted = value
    sensitive_values = _sensitive_output_values()
    marker = _redaction_marker(sensitive_values)
    for sensitive in sensitive_values:
        redacted = redacted.replace(sensitive, marker)
    return redacted[:limit]


def _harbor_child_environment(
    environment: Mapping[str, str] = os.environ,
    *,
    agent_timeout_seconds: int | None = None,
) -> dict[str, str]:
    child_environment = {
        name: value
        for name, value in environment.items()
        if name in _HARBOR_CHILD_ENVIRONMENT
    }
    if agent_timeout_seconds is not None:
        child_environment["HARBOR_HF_AGENT_TIMEOUT_SECONDS"] = str(
            agent_timeout_seconds
        )
    return child_environment


def _log_harbor_exception(task: LockedTask, result: dict[str, Any]) -> None:
    """Copy Harbor's exception into Job logs without the traceback."""
    if "exception_info" not in result or not isinstance(result["exception_info"], dict):
        return
    exception = result["exception_info"]
    message = (
        str(exception["exception_message"]) if "exception_message" in exception else ""
    )
    exception_type = (
        str(exception["exception_type"]) if "exception_type" in exception else "unknown"
    )
    _LOGGER.error(
        "Harbor task %s failed with %s: %s",
        task.task_id,
        exception_type,
        _redact_text(message, limit=2000),
    )


def _run_logged_command(  # noqa: C901 -- bounded streaming state machine
    command: list[str],
    timeout_seconds: int,
    env: dict[str, str],
) -> tuple[str, bool]:
    """Stream bounded redacted output and stop the complete process group."""
    sensitive_values = _sensitive_output_values(env)
    marker = _redaction_marker(sensitive_values)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env=env,
    )
    if process.stdout is None:
        raise RuntimeError("Harbor process output pipe is unavailable")
    output_stream = process.stdout
    chunks: deque[str] = deque()
    retained_chars = 0
    streamed_chars = 0
    output_truncated = False
    reader_errors: list[BaseException] = []

    def emit(value: str) -> None:
        nonlocal retained_chars, streamed_chars, output_truncated
        if not value:
            return
        available = max(0, _MAX_HARBOR_OUTPUT_BYTES - streamed_chars)
        if available:
            emitted = value[:available]
            _LOGGER.info("%s", emitted.rstrip())
            streamed_chars += len(emitted)
        if len(value) > available and not output_truncated:
            output_truncated = True
            _LOGGER.warning(
                "Harbor process output exceeded %d bytes and was truncated",
                _MAX_HARBOR_OUTPUT_BYTES,
            )
        chunks.append(value)
        retained_chars += len(value)
        while retained_chars > _MAX_HARBOR_OUTPUT_BYTES and chunks:
            overflow = retained_chars - _MAX_HARBOR_OUTPUT_BYTES
            first = chunks[0]
            if len(first) <= overflow:
                retained_chars -= len(chunks.popleft())
            else:
                chunks[0] = first[overflow:]
                retained_chars -= overflow

    def copy_output() -> None:
        try:
            pending = ""
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            while raw := os.read(output_stream.fileno(), _LOG_READ_BYTES):
                pending += decoder.decode(raw)
                redacted, pending = _redact_pending_output(
                    pending,
                    sensitive_values,
                    marker,
                    final=False,
                )
                emit(redacted)
            pending += decoder.decode(b"", final=True)
            redacted, _ = _redact_pending_output(
                pending,
                sensitive_values,
                marker,
                final=True,
            )
            emit(redacted)
        except BaseException as error:
            reader_errors.append(error)

    reader = threading.Thread(target=copy_output, daemon=True)
    reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    if not timed_out:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    reader.join(timeout=_LOG_DRAIN_SECONDS)
    if reader.is_alive():
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        reader.join(timeout=_LOG_DRAIN_SECONDS)
    if reader.is_alive():
        output_stream.close()
        reader.join(timeout=_LOG_DRAIN_SECONDS)
    if reader.is_alive():
        raise RuntimeError("command output reader did not stop")
    if reader_errors:
        raise RuntimeError("command output reader failed") from reader_errors[0]
    output = "".join(chunks)
    if output_truncated:
        output += _OUTPUT_TRUNCATION_NOTICE.decode()
    return output, timed_out


def _run_harbor(
    config: WorkerConfig,
    root: Path,
    path: Path,
) -> tuple[str, bool, Path]:
    task = config.task
    output, timed_out = _run_logged_command(
        ["harbor", "run", "--config", str(path), "--yes"],
        task.timeout_seconds + 600,
        _harbor_child_environment(
            agent_timeout_seconds=task.agent_timeout_seconds,
        ),
    )
    result_path = _result_path(root, task)
    if result_path is None:
        raise MissingHarborResultError(
            "Harbor did not write a trial result",
            timed_out=timed_out,
        )
    return output, timed_out, result_path


def _expected_trial_lock(
    config: WorkerConfig,
    observed_lock: TrialLock,
) -> TrialLock:
    if not config.historical:
        return config.task.trial_lock
    expected_agent_value = copy.deepcopy(config.harbor_agent)
    expected_agent_value["skills"] = []
    expected_agent = AgentConfig.model_validate(expected_agent_value)
    if observed_lock.agent != expected_agent:
        raise WorkerEvidenceError("executed Harbor agent differs from the continuation")
    # Continuations may update the reviewed agent implementation while the
    # prepared task, environment, verifier, and other inputs stay immutable.
    return config.task.trial_lock.model_copy(update={"agent": expected_agent})


def _verified_result(config: WorkerConfig, result_path: Path) -> dict[str, Any]:
    task = config.task
    observed_lock_path = result_path.parent / "lock.json"
    if not observed_lock_path.exists():
        raise WorkerEvidenceError("Harbor did not write a trial lock")
    observed_lock = TrialLock.model_validate_json(
        _read_bounded_file(
            observed_lock_path,
            _MAX_JSON_BYTES,
            label="Harbor trial lock",
        )
    )
    expected_lock = _expected_trial_lock(config, observed_lock)
    if observed_lock != expected_lock:
        raise WorkerEvidenceError("executed Harbor trial lock differs from preparation")
    result_value = json.loads(
        _read_bounded_file(
            result_path,
            _MAX_JSON_BYTES,
            label="Harbor trial result",
        )
    )
    if not isinstance(result_value, dict):
        raise WorkerEvidenceError("Harbor trial result must be a JSON object")
    _log_harbor_exception(task, result_value)
    sensitive_values = _sensitive_output_values()
    trial_files = _regular_trial_files(result_path.parent)
    for trial_path in result_path.parent.rglob("*"):
        relative = trial_path.relative_to(result_path.parent).as_posix()
        if any(sensitive in relative for sensitive in sensitive_values):
            raise WorkerEvidenceError(
                "sensitive worker setting leaked into trial evidence"
            )
    for trial_file in trial_files:
        if any(
            _contains_bytes(trial_file, sensitive.encode())
            for sensitive in sensitive_values
        ):
            raise WorkerEvidenceError(
                "sensitive worker setting leaked into trial evidence"
            )
    return result_value


def _deliver_result(
    config: WorkerConfig,
    root: Path,
    result_path: Path,
    result_value: dict[str, Any],
    output: str,
    timed_out: bool,
) -> None:
    task = config.task
    archive = _archive_trial(root, task, result_path, output)
    outcome_override: tuple[str, bool] | None = None
    failure_class_override: str | None = None
    try:
        digest, evidence_path = _upload_evidence(config, archive)
    except ControlClientError as error:
        _LOGGER.error(
            "Evidence upload failed for task %s: %s",
            task.task_id,
            _redact_text(str(error), limit=500),
        )
        digest, evidence_path = _upload_failure_note(_config_identity(config), error)
        outcome_override = _worker_failure_outcome(error)
        failure_class_override = type(error).__name__
    _submit_attempt(
        config,
        result_value,
        output,
        digest,
        evidence_path,
        timed_out=timed_out,
        outcome_override=outcome_override,
        failure_class_override=failure_class_override,
    )


def _run_task_once(config: WorkerConfig, root: Path) -> None:
    task = config.task
    path = _job_config(config, root)
    _LOGGER.info(
        "Starting Harbor task %s with %d second phase budget",
        task.task_id,
        task.timeout_seconds,
    )
    output, timed_out, result_path = _run_harbor(config, root, path)
    result_value = _verified_result(config, result_path)
    _deliver_result(
        config,
        root,
        result_path,
        result_value,
        output,
        timed_out,
    )


def _run_task(config: WorkerConfig, root: Path) -> None:
    try:
        _run_task_once(config, root)
    except Exception as error:
        if "sensitive worker setting leaked" in str(error):
            raise
        outcome, replacement_eligible = _worker_failure_outcome(error)
        _submit_failure_attempt(
            _config_identity(config),
            error,
            outcome=outcome,
            replacement_eligible=replacement_eligible,
        )
        _LOGGER.error(
            "Harbor task %s failed before delivery: %s",
            config.task.task_id,
            _redact_text(str(error), limit=500),
        )


def main() -> None:
    """Validate one assignment, run it, and submit one attempt receipt."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if _required("HARBOR_HF_WORKER_ROLE") != "execution":
        raise RuntimeError("control worker role is invalid")
    for name in ("HF_TOKEN", "HF_INFERENCE_TOKEN"):
        if name in os.environ and os.environ[name]:
            raise RuntimeError(f"control worker must not retain {name}")
    task_id = _assigned_task_id()
    run_id = _required("HARBOR_HF_RUN_ID")
    identity = WorkerIdentity(
        run_id=run_id,
        action_id=_required("HARBOR_HF_ACTION_ID"),
        task_id=task_id,
    )
    _LOGGER.info(
        "Starting action %s for run %s task %s",
        identity.action_id,
        run_id,
        task_id,
    )
    try:
        config = _locked_config(_read_lock(run_id))
        if version("harbor") != config.harbor_version:
            raise PreparedDataError(
                "Harbor version does not match the deployment profile"
            )
        if _required("HARBOR_HF_WORKER_REVISION") != config.worker_revision:
            raise PreparedDataError(
                "worker revision does not match the deployment profile"
            )
        ControlJobEnvironment.preflight()
    except Exception as error:
        outcome, replacement_eligible = _worker_failure_outcome(error)
        _submit_failure_attempt(
            identity,
            error,
            outcome=outcome,
            replacement_eligible=replacement_eligible,
        )
        _LOGGER.error(
            "Worker preparation failed for task %s: %s",
            task_id,
            _redact_text(str(error), limit=500),
        )
        return
    with tempfile.TemporaryDirectory(prefix="harbor-hf-control-worker-") as temporary:
        _run_task(config, Path(temporary))
    _LOGGER.info(
        "Completed action %s for run %s task %s",
        config.action_id,
        config.run_id,
        config.task.task_id,
    )


if __name__ == "__main__":
    main()

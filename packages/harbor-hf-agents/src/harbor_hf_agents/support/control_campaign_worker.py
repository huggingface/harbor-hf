"""Run locked Harbor trials and submit evidence through a worker capability."""

from __future__ import annotations

import base64
import concurrent.futures
import json
import math
import os
import shutil
import subprocess
import tarfile
import tempfile
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from harbor_hf_agents.support.control_sandbox_environment import _ControlClient, _digest

_EVIDENCE_CHUNK_BYTES = 16 * 1024 * 1024
_POLICY_FAILURES = {
    "AgentAuthenticationError",
    "ApiUsageLimitError",
    "ModelNotFoundError",
}
_INFRASTRUCTURE_MARKERS = ("Sandbox", "Connection", "Network", "HTTP")


@dataclass(frozen=True)
class LockedTask:
    task_id: str
    source_task_id: str
    trial_index: int
    input_digest: str
    image: str
    timeout_seconds: int


@dataclass(frozen=True)
class WorkerConfig:
    campaign_id: str
    action_id: str
    benchmark_revision: str
    source_repository: str
    source_path: str
    model_id: str
    model_revision: str
    routed_model: str
    agent_version: str
    reasoning_effort: str
    harbor_version: str
    worker_revision: str
    concurrency: int
    max_tasks_per_job: int
    context_window: int
    max_output_tokens: int
    provider_timeout_seconds: int
    input_price: int
    output_price: int
    tasks: tuple[LockedTask, ...]


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required control worker setting {name} is missing")
    return value


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _profile(lock: dict[str, Any], kind: str) -> dict[str, Any]:
    matches = [item for item in lock.get("profiles", []) if item.get("kind") == kind]
    if len(matches) != 1 or not isinstance(matches[0].get("spec"), dict):
        raise RuntimeError(f"campaign lock must contain one {kind} profile")
    return matches[0]["spec"]


def _read_lock(campaign_id: str) -> dict[str, Any]:
    client = _ControlClient(campaign_id, "lock-reader")
    return client.request(
        "GET",
        f"/api/v1/campaigns/{campaign_id}/lock",
        idempotency_key=f"control-worker-lock-{_required('HARBOR_HF_ACTION_ID')}",
        timeout=60.0,
    )


def _locked_config(lock: dict[str, Any]) -> WorkerConfig:
    campaign_id = _required("HARBOR_HF_CAMPAIGN_ID")
    action_id = _required("HARBOR_HF_ACTION_ID")
    if lock.get("campaign_id") != campaign_id:
        raise RuntimeError("campaign lock identity does not match worker environment")
    benchmark = _profile(lock, "benchmark")
    model = _profile(lock, "model")
    harness = _profile(lock, "harness")
    deployment = _profile(lock, "deployment")
    if deployment.get("route") != "hf_job":
        raise RuntimeError("control worker requires an HF Job deployment")
    base = deployment.get("sandbox")
    task_specs = deployment.get("task_sandboxes")
    if not isinstance(base, dict) or not isinstance(task_specs, list):
        raise RuntimeError("control worker requires task Sandbox profiles")
    task_locks = {item["task_id"]: item["input_digest"] for item in lock["tasks"]}
    by_id = {item["task_id"]: item for item in task_specs}
    if set(by_id) != set(task_locks):
        raise RuntimeError("task Sandbox profiles do not match assigned lock tasks")
    tasks = tuple(
        LockedTask(
            task_id=task_id,
            source_task_id=str(by_id[task_id]["source_task_id"]),
            trial_index=int(by_id[task_id]["trial_index"]),
            input_digest=str(input_digest),
            image=str(by_id[task_id]["image"]),
            timeout_seconds=int(by_id[task_id]["timeout_seconds"]),
        )
        for task_id, input_digest in sorted(task_locks.items())
    )
    routed_model = str(base.get("inference_model", ""))
    if not routed_model.startswith(f"{model['model_id']}:"):
        raise RuntimeError("routed provider model does not match the model profile")
    source_repository = str(benchmark.get("source_repository", ""))
    if not source_repository.startswith("https://github.com/"):
        raise RuntimeError("benchmark source must be anonymous public GitHub HTTPS")
    return WorkerConfig(
        campaign_id=campaign_id,
        action_id=action_id,
        benchmark_revision=str(benchmark["revision"]),
        source_repository=source_repository,
        source_path=str(benchmark["source_path"]),
        model_id=str(model["model_id"]),
        model_revision=str(model["revision"]),
        routed_model=routed_model,
        agent_version=str(harness["revision"]),
        reasoning_effort=str(harness["reasoning_effort"]),
        harbor_version=str(deployment["harbor_version"]),
        worker_revision=str(deployment["worker_revision"]),
        concurrency=int(deployment["worker_concurrency"]),
        max_tasks_per_job=int(deployment["worker_max_tasks_per_job"]),
        context_window=int(deployment["context_window"]),
        max_output_tokens=int(base["inference_max_output_tokens"]),
        provider_timeout_seconds=int(base["inference_timeout_seconds"]),
        input_price=int(deployment["input_price_microusd_per_million_tokens"]),
        output_price=int(deployment["output_price_microusd_per_million_tokens"]),
        tasks=tasks,
    )


def _clone_source(config: WorkerConfig, destination: Path) -> Path:
    subprocess.run(["git", "init", "-q", str(destination)], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(destination),
            "remote",
            "add",
            "origin",
            config.source_repository,
        ],
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(destination),
            "fetch",
            "-q",
            "--depth=1",
            "origin",
            config.benchmark_revision,
        ],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(destination), "checkout", "-q", "--detach", "FETCH_HEAD"],
        check=True,
    )
    observed = subprocess.check_output(
        ["git", "-C", str(destination), "rev-parse", "HEAD"], text=True
    ).strip()
    if observed != config.benchmark_revision:
        raise RuntimeError("benchmark source revision mismatch")
    source = (destination / config.source_path).resolve()
    if destination.resolve() not in source.parents or not source.is_dir():
        raise RuntimeError("benchmark source path is invalid")
    return source


def _task_manifest(source: Path) -> dict[str, str]:
    import tomllib

    value = tomllib.loads((source / "dataset.toml").read_text())
    result: dict[str, str] = {}
    for item in value["tasks"]:
        name = str(item["name"]).split("/", 1)[-1]
        result[name] = str(item["digest"])
    return result


def _image_repository(value: str) -> str:
    without_digest = value.split("@", 1)[0]
    tail = without_digest.rsplit("/", 1)[-1]
    if ":" in tail:
        return without_digest.rsplit(":", 1)[0]
    return without_digest


def _validate_tasks(config: WorkerConfig, source: Path) -> None:
    import tomllib

    manifest = _task_manifest(source)
    for task in config.tasks:
        task_dir = source / task.source_task_id
        if not task_dir.is_dir() or task.source_task_id not in manifest:
            raise RuntimeError(f"locked source task is missing: {task.source_task_id}")
        if manifest[task.source_task_id] != task.input_digest:
            raise RuntimeError(f"locked task digest mismatch: {task.task_id}")
        task_toml = tomllib.loads((task_dir / "task.toml").read_text())
        declared = str(task_toml["environment"]["docker_image"])
        if _image_repository(declared) != _image_repository(task.image):
            raise RuntimeError(f"locked task image mismatch: {task.task_id}")


def _harbor_version() -> str:
    harbor = shutil.which("harbor")
    if not harbor:
        raise RuntimeError("Harbor executable is missing")
    return subprocess.check_output([harbor, "--version"], text=True).strip()


def _job_config(
    config: WorkerConfig, task: LockedTask, source: Path, root: Path
) -> Path:
    model_cost = {
        "input": config.input_price / 1_000_000,
        "output": config.output_price / 1_000_000,
        "cacheRead": config.input_price / 1_000_000,
        "cacheWrite": config.input_price / 1_000_000,
    }
    job_name = task.task_id
    value = {
        "job_name": job_name,
        "jobs_dir": str(root / "jobs"),
        "n_attempts": 1,
        "n_concurrent_trials": 1,
        "retry": {"max_retries": 0},
        "agents": [
            {
                "name": "harbor_hf_agents.pi.agent:PiAgent",
                "model_name": f"openai/{config.routed_model}",
                "n_concurrent": 1,
                "kwargs": {
                    "version": config.agent_version,
                    "thinking": config.reasoning_effort,
                    "models_json": {
                        "providers": {
                            "openai": {
                                "baseUrl": "$OPENAI_BASE_URL",
                                "api": "openai-completions",
                                "compat": {
                                    "supportsDeveloperRole": False,
                                    "supportsReasoningEffort": True,
                                    "maxTokensField": "max_tokens",
                                },
                                "models": [
                                    {
                                        "id": config.routed_model,
                                        "name": config.routed_model,
                                        "reasoning": True,
                                        "input": ["text"],
                                        "contextWindow": config.context_window,
                                        "maxTokens": config.max_output_tokens,
                                        "cost": model_cost,
                                    }
                                ],
                            }
                        }
                    },
                    "provider_runtime": {
                        "api": "chat-completions",
                        "timeout_seconds": config.provider_timeout_seconds,
                        "max_attempts": 1,
                    },
                },
            }
        ],
        "environment": {
            "import_path": (
                "harbor_hf_agents.support.control_sandbox_environment:"
                "ControlSandboxEnvironment"
            ),
            "delete": True,
            "kwargs": {"control_task_id": task.task_id},
        },
        "artifacts": [{"source": "/app", "destination": "workspace/app"}],
        "tasks": [{"path": str(source / task.source_task_id)}],
    }
    path = root / "configs" / f"{task.task_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return path


def _result_path(root: Path, task: LockedTask) -> Path | None:
    matches = list((root / "jobs" / task.task_id).glob("*/result.json"))
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
        if any(marker in stderr for marker in _POLICY_FAILURES):
            return "policy", False
        return "infrastructure", True
    exception = result.get("exception_info")
    if not exception:
        return "complete", False
    name = (
        str(exception.get("exception_type", "")) if isinstance(exception, dict) else ""
    )
    if name in {"AgentTimeoutError", "VerifierTimeoutError"}:
        return "benchmark_timeout", False
    if any(marker in name for marker in _INFRASTRUCTURE_MARKERS):
        return "infrastructure", True
    if "Verifier" in name or "Reward" in name:
        return "verifier", False
    if "Refusal" in name:
        return "refusal", False
    return "agent", False


def _metrics(result: dict[str, Any] | None) -> tuple[dict[str, float], int]:
    if result is None:
        return {}, 0
    metrics: dict[str, float] = {}
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    for name, value in rewards.items():
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            metrics[name] = float(value)
    agent = result.get("agent_result") or {}
    input_tokens = int(agent.get("n_input_tokens") or 0)
    output_tokens = int(agent.get("n_output_tokens") or 0)
    metrics["input_tokens"] = float(input_tokens)
    metrics["output_tokens"] = float(output_tokens)
    return metrics, input_tokens + output_tokens


def _cost_microusd(config: WorkerConfig, result: dict[str, Any] | None) -> int:
    if result is None:
        return 0
    agent = result.get("agent_result") or {}
    input_tokens = int(agent.get("n_input_tokens") or 0)
    output_tokens = int(agent.get("n_output_tokens") or 0)
    return math.ceil(
        input_tokens * config.input_price / 1_000_000
        + output_tokens * config.output_price / 1_000_000
    )


def _archive_trial(
    root: Path, task: LockedTask, result_path: Path | None, stderr: str
) -> Path:
    evidence_root = root / "evidence" / task.task_id
    evidence_root.mkdir(parents=True, exist_ok=True)
    (evidence_root / "worker-stderr.txt").write_text(stderr[-1_000_000:])
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
        handle.add(evidence_root / "worker-stderr.txt", arcname="worker-stderr.txt")
        if result_path:
            handle.add(result_path.parent, arcname="harbor-trial")
    return archive


def _upload_evidence(
    config: WorkerConfig,
    task: LockedTask,
    archive: Path,
) -> tuple[str, str]:
    client = _ControlClient(config.campaign_id, task.task_id)
    attempt_path = f"{client.prefix}/attempts"
    objects: list[dict[str, Any]] = []
    with archive.open("rb") as handle:
        index = 0
        while chunk := handle.read(_EVIDENCE_CHUNK_BYTES):
            digest = _digest(chunk)
            uploaded = client.request(
                "POST",
                attempt_path,
                body={
                    "operation": "upload_evidence",
                    "action_id": config.action_id,
                    "digest": digest,
                    "content_base64": base64.b64encode(chunk).decode(),
                },
                idempotency_key=(
                    f"evidence-{config.action_id}-{task.task_id}-{index:06d}"
                ),
                timeout=300.0,
            )
            objects.append(
                {
                    "path": uploaded["path"],
                    "digest": digest,
                    "size": len(chunk),
                }
            )
            index += 1
    index_bytes = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "harbor.trial.chunk-index",
            "campaign_id": config.campaign_id,
            "action_id": config.action_id,
            "task_id": task.task_id,
            "archive": "trial.tar.gz",
            "archive_size": archive.stat().st_size,
            "chunks": objects,
        }
    )
    index_digest = _digest(index_bytes)
    uploaded_index = client.request(
        "POST",
        attempt_path,
        body={
            "operation": "upload_evidence",
            "action_id": config.action_id,
            "digest": index_digest,
            "content_base64": base64.b64encode(index_bytes).decode(),
        },
        idempotency_key=f"evidence-index-{config.action_id}-{task.task_id}",
        timeout=120.0,
    )
    objects.append(
        {
            "path": uploaded_index["path"],
            "digest": index_digest,
            "size": len(index_bytes),
        }
    )
    manifest_bytes = _canonical_json(
        {
            "schema_version": "v1",
            "kind": "worker.evidence.manifest",
            "campaign_id": config.campaign_id,
            "action_id": config.action_id,
            "task_id": task.task_id,
            "objects": objects,
        }
    )
    manifest_digest = _digest(manifest_bytes)
    uploaded_manifest = client.request(
        "POST",
        attempt_path,
        body={
            "operation": "upload_evidence",
            "action_id": config.action_id,
            "digest": manifest_digest,
            "content_base64": base64.b64encode(manifest_bytes).decode(),
        },
        idempotency_key=f"evidence-manifest-{config.action_id}-{task.task_id}",
        timeout=120.0,
    )
    return manifest_digest, str(uploaded_manifest["path"])


def _submit_attempt(
    config: WorkerConfig,
    task: LockedTask,
    result: dict[str, Any] | None,
    stderr: str,
    evidence_digest: str,
    evidence_path: str,
    *,
    timed_out: bool = False,
) -> None:
    outcome, replacement = _exception_outcome(result, stderr, timed_out=timed_out)
    metrics, _ = _metrics(result)
    client = _ControlClient(config.campaign_id, task.task_id)
    client.request(
        "POST",
        f"{client.prefix}/attempts",
        body={
            "action_id": config.action_id,
            "outcome": outcome,
            "replacement_eligible": replacement,
            "evidence_digest": evidence_digest,
            "evidence_path": evidence_path,
            "cost_microusd": _cost_microusd(config, result),
            "metrics": metrics,
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "confirmed": True,
        },
        idempotency_key=f"attempt-{config.action_id}-{task.task_id}",
        timeout=120.0,
    )


def _run_task(config: WorkerConfig, task: LockedTask, source: Path, root: Path) -> str:
    path = _job_config(config, task, source, root)
    timed_out = False
    try:
        process = subprocess.run(
            ["harbor", "run", "--config", str(path), "--yes"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=task.timeout_seconds + 600,
        )
        output = process.stdout
    except subprocess.TimeoutExpired as error:
        timed_out = True
        raw = error.stdout or ""
        output = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    result_path = _result_path(root, task)
    result = json.loads(result_path.read_text()) if result_path else None
    capability = _required("HARBOR_HF_WORKER_CAPABILITY").encode()
    if result_path:
        for trial_file in result_path.parent.rglob("*"):
            if trial_file.is_file() and capability in trial_file.read_bytes():
                raise RuntimeError("worker capability leaked into trial evidence")
    archive = _archive_trial(root, task, result_path, output)
    digest, evidence_path = _upload_evidence(config, task, archive)
    _submit_attempt(
        config,
        task,
        result,
        output,
        digest,
        evidence_path,
        timed_out=timed_out,
    )
    return task.task_id


def main() -> None:  # noqa: C901 -- bounded batch orchestration
    if os.environ.get("HF_TOKEN"):
        raise RuntimeError("control worker must not receive HF_TOKEN")
    lock = _read_lock(_required("HARBOR_HF_CAMPAIGN_ID"))
    config = _locked_config(lock)
    if _harbor_version() != config.harbor_version:
        raise RuntimeError("Harbor version does not match the deployment profile")
    if _required("HARBOR_HF_WORKER_REVISION") != config.worker_revision:
        raise RuntimeError("worker revision does not match the deployment profile")
    with tempfile.TemporaryDirectory(prefix="harbor-hf-control-worker-") as temporary:
        root = Path(temporary)
        source = _clone_source(config, root / "source")
        _validate_tasks(config, source)
        failures: list[BaseException] = []
        completed: list[str] = []
        lock_guard = threading.Lock()
        assigned_tasks = config.tasks[: config.max_tasks_per_job]
        width = min(config.concurrency, len(assigned_tasks))
        with concurrent.futures.ThreadPoolExecutor(max_workers=width) as executor:
            for offset in range(0, len(assigned_tasks), width):
                batch = assigned_tasks[offset : offset + width]
                futures = {
                    executor.submit(_run_task, config, task, source, root): task
                    for task in batch
                }
                for future in concurrent.futures.as_completed(futures):
                    try:
                        task_id = future.result()
                        with lock_guard:
                            completed.append(task_id)
                    except BaseException as error:
                        failures.append(error)
                if failures:
                    break
        if failures:
            raise RuntimeError(
                f"{len(failures)} control worker task(s) failed before receipt; "
                f"first={type(failures[0]).__name__}"
            ) from failures[0]
        print(
            json.dumps(
                {
                    "status": "complete",
                    "campaign_id": config.campaign_id,
                    "action_id": config.action_id,
                    "task_count": len(completed),
                    "assigned_task_count": len(config.tasks),
                    "partial": len(completed) < len(config.tasks),
                },
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    main()

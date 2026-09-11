"""Run one Harbor job from its immutable Bucket record."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from harbor.job import Job
from harbor.models.job.config import JobConfig
from harbor.models.job.result import JobResult
from harbor.models.trial.result import TrialResult
from harbor.trial.hooks import HookCallback, TrialHookEvent
from huggingface_hub import HfApi
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from harbor_hf_agents.bucket_artifacts import BucketArtifacts
from harbor_hf_agents.launch import REVISION, check_revision, check_sources
from harbor_hf_agents.scrub_before_upload import scrub_before_upload

_RUN_ID = re.compile(r"^run-[0-9a-f]{24}$")


class CostCeilingExceeded(RuntimeError):
    """Completed trial cost crossed an approved ceiling."""


class ControlledRunStop(RuntimeError):
    """A control request interrupted one in-flight Harbor trial."""

    def __init__(self, trial_name: str) -> None:
        super().__init__(f"controlled stop interrupted trial {trial_name}")
        self.trial_name = trial_name


class AttemptCostReceipt(BaseModel):
    """Durable cost evidence for one Harbor trial attempt."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["v1"] = "v1"
    attempt_id: UUID
    trial_name: str = Field(min_length=1, max_length=512)
    cost_usd: float | None = Field(ge=0)


@dataclass(frozen=True)
class CostCeiling:
    """Validated campaign or legacy per-trial cost policy."""

    usd: float
    scope: Literal["campaign", "trial"]


def _record(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return cast(dict[str, Any], value)


def load_run_record(mount_root: Path, run_id: str) -> dict[str, Any]:
    """Load and check the immutable record assigned to this parent."""
    if not _RUN_ID.fullmatch(run_id):
        raise ValueError("HARBOR_HF_RUN_ID is invalid")
    path = mount_root / "runs" / run_id / "run.json"
    value = _record(json.loads(path.read_text(encoding="utf-8")), "run record")
    if value.get("schema_version") != "v1" or value.get("run_id") != run_id:
        raise ValueError("run record identity does not match the parent assignment")
    return value


def job_config(record: dict[str, Any], mount_root: Path, run_id: str) -> JobConfig:
    """Validate the secret-free Harbor configuration and its owned paths."""
    value = _record(record.get("harbor_job_config"), "harbor_job_config")
    expected_jobs_dir = str(mount_root / "runs" / run_id)
    if value.get("job_name") != "job" or value.get("jobs_dir") != expected_jobs_dir:
        raise ValueError("Harbor job path does not match the run folder")
    environment = _record(value.get("environment"), "environment")
    if environment.get("import_path") != (
        "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment"
    ):
        raise ValueError("Harbor job does not use the labeled HF environment")
    kwargs = _record(environment.get("kwargs"), "environment kwargs")
    if kwargs.get("run_label") != run_id:
        raise ValueError("Harbor child Job label does not match the run")
    return JobConfig.model_validate(value)


def cost_ceiling(record: dict[str, Any]) -> CostCeiling:
    """Read one finite positive campaign or legacy per-trial ceiling."""
    submission = _record(record.get("submission"), "submission")
    present = [
        ("campaign", submission.get("cost_ceiling_usd")),
        ("trial", submission.get("cost_ceiling_usd_per_trial")),
    ]
    selected = [(scope, value) for scope, value in present if value is not None]
    if len(selected) != 1:
        raise ValueError("run record must contain exactly one cost ceiling")
    scope, value = selected[0]
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError("cost ceiling must be a number")
    ceiling = float(value)
    if not 0 < ceiling <= 10_000:
        raise ValueError("cost ceiling must be positive")
    return CostCeiling(ceiling, cast(Literal["campaign", "trial"], scope))


def _attempts_dir(run_dir: Path) -> Path:
    return run_dir / "attempt-costs"


def _agent_execution_started(result: TrialResult) -> bool:
    if result.agent_result is not None:
        return True
    if result.agent_execution and result.agent_execution.started_at is not None:
        return True
    return any(
        step.agent_result is not None
        or (
            step.agent_execution is not None
            and step.agent_execution.started_at is not None
        )
        for step in result.step_results or []
    )


def _reported_cost(result: TrialResult) -> float | None:
    *_, cost = result.compute_token_cost_totals()
    return cost if cost is not None and math.isfinite(cost) and cost >= 0 else None


def _receipt_for(result: TrialResult) -> AttemptCostReceipt:
    safe_cost = _reported_cost(result)
    if safe_cost is None and not _agent_execution_started(result):
        safe_cost = 0.0
    return AttemptCostReceipt(
        attempt_id=result.id,
        trial_name=result.trial_name,
        cost_usd=safe_cost,
    )


def _write_receipt(run_dir: Path, receipt: AttemptCostReceipt) -> None:
    directory = _attempts_dir(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{receipt.attempt_id}.json"
    if path.exists():
        existing = AttemptCostReceipt.model_validate_json(
            path.read_text(encoding="utf-8")
        )
        if existing != receipt:
            raise RuntimeError("attempt cost receipt conflicts with durable evidence")
        return
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(receipt.model_dump_json(indent=2))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_attempt_costs(run_dir: Path) -> dict[UUID, AttemptCostReceipt]:
    """Load receipts and preserve cost evidence from current Harbor results."""
    directory = _attempts_dir(run_dir)
    receipts: dict[UUID, AttemptCostReceipt] = {}
    if directory.exists():
        for path in sorted(directory.glob("*.json")):
            receipt = AttemptCostReceipt.model_validate_json(
                path.read_text(encoding="utf-8")
            )
            if path.stem != str(receipt.attempt_id):
                raise RuntimeError("attempt cost receipt path does not match its id")
            receipts[receipt.attempt_id] = receipt
    job_dir = run_dir / "job"
    if job_dir.exists():
        for path in sorted(job_dir.glob("*/result.json")):
            result = TrialResult.model_validate_json(path.read_text(encoding="utf-8"))
            existing = receipts.get(result.id)
            if existing is not None:
                if existing != _receipt_for(result):
                    raise RuntimeError(
                        "attempt cost receipt conflicts with durable evidence"
                    )
                continue
            receipt = _receipt_for(result)
            _write_receipt(run_dir, receipt)
            receipts[receipt.attempt_id] = receipt
    return receipts


def _desired_state(run_dir: Path) -> str:
    try:
        value = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "run"
    return value.get("desired_state", "run") if isinstance(value, dict) else "run"


def cleanup_interrupted_trial(run_dir: Path, trial_name: str) -> None:
    """Remove Harbor's terminal view of a control-interrupted trial."""
    job_dir = (run_dir / "job").resolve()
    trial_dir = (job_dir / trial_name).resolve()
    if trial_dir.parent != job_dir:
        raise RuntimeError("interrupted trial path escapes the Harbor job folder")
    if trial_dir.exists():
        shutil.rmtree(trial_dir)
    (job_dir / "result.json").unlink(missing_ok=True)


def _interrupted_trial_names(error: BaseException) -> list[str]:
    if isinstance(error, ControlledRunStop):
        return [error.trial_name]
    if isinstance(error, BaseExceptionGroup):
        return [
            name
            for nested in error.exceptions
            for name in _interrupted_trial_names(nested)
        ]
    return []


def _cost_violation(
    receipts: dict[UUID, AttemptCostReceipt],
    ceiling: CostCeiling,
    planned_trials: int,
) -> str | None:
    if ceiling.scope == "campaign":
        total = sum(item.cost_usd or 0 for item in receipts.values())
        if total > ceiling.usd:
            return "completed trial cost exceeded the campaign ceiling"
        return None

    expensive = next(
        (
            item
            for item in receipts.values()
            if item.cost_usd is not None and item.cost_usd > ceiling.usd
        ),
        None,
    )
    if expensive:
        return f"trial {expensive.trial_name} reported cost above its ceiling"
    exposure = sum(item.cost_usd or 0 for item in receipts.values())
    if exposure > ceiling.usd * planned_trials:
        return "completed trial cost exposure exceeded the run ceiling"
    return None


def _harbor_job_is_terminal(
    run_dir: Path, planned_trials: int, max_retries: int
) -> bool:
    """Return whether Harbor proves that no configured work can spend."""
    if max_retries != 0:
        return False
    try:
        result = JobResult.model_validate_json(
            (run_dir / "job" / "result.json").read_text(encoding="utf-8")
        )
    except (OSError, ValidationError):
        return False

    progress = (
        result.stats.n_completed_trials,
        result.stats.n_running_trials,
        result.stats.n_pending_trials,
    )
    if any(value < 0 for value in progress):
        return False
    return (
        result.n_total_trials == planned_trials
        and result.stats.n_completed_trials == planned_trials
        and result.stats.n_running_trials == 0
        and result.stats.n_pending_trials == 0
    )


def _enforce_cost_ceiling(
    receipts: dict[UUID, AttemptCostReceipt],
    ceiling: CostCeiling,
    planned_trials: int,
    run_dir: Path,
    max_retries: int,
) -> None:
    violation = _cost_violation(receipts, ceiling, planned_trials)
    if violation is None or _harbor_job_is_terminal(
        run_dir, planned_trials, max_retries
    ):
        return
    raise CostCeilingExceeded(violation)


def make_cost_hook(
    ceiling: CostCeiling,
    planned_trials: int,
    run_dir: Path,
    *,
    max_retries: int,
) -> HookCallback:
    """Return Harbor's durable post-trial cost callback."""
    if planned_trials <= 0:
        raise ValueError("planned trial count must be positive")
    receipts = load_attempt_costs(run_dir)
    _enforce_cost_ceiling(receipts, ceiling, planned_trials, run_dir, max_retries)

    async def check_cost(event: TrialHookEvent) -> None:
        receipt = _receipt_for(event.result)
        controlled = _desired_state(run_dir) in {"paused", "cancelled"}
        if not controlled or _reported_cost(event.result) is not None:
            _write_receipt(run_dir, receipt)
            receipts.setdefault(receipt.attempt_id, receipt)
            _enforce_cost_ceiling(
                receipts, ceiling, planned_trials, run_dir, max_retries
            )
        if controlled:
            raise ControlledRunStop(receipt.trial_name)

    return check_cost


async def run_parent() -> None:
    """Run Harbor on local disk and persist native files through the Bucket API."""
    run_id = os.environ.get("HARBOR_HF_RUN_ID", "")
    if not _RUN_ID.fullmatch(run_id):
        raise ValueError("HARBOR_HF_RUN_ID is invalid")
    local_root = Path(os.environ.get("HARBOR_HF_LOCAL_ROOT", "/data")).resolve()
    run_dir = local_root / "runs" / run_id
    artifacts = BucketArtifacts(
        HfApi(), os.environ.get("HARBOR_HF_BUCKET_ID", ""), run_dir
    )
    check_revision()
    await artifacts.restore()
    record = load_run_record(local_root, run_id)
    if record.get("harbor_revision") != REVISION:
        raise ValueError("Run Harbor revision does not match the parent image")
    config = job_config(record, local_root, run_id)
    check_sources(config)
    with scrub_before_upload() as scrub:
        job = await Job.create(config)
        await _run_local_job(job, record, config, artifacts)
        # Expected cost/control stops have completed native cleanup. Unexpected
        # failures propagate without a whole-tree upload of uncertain output.
        if scrub.failed:
            raise RuntimeError("Native sanitization failed; final upload blocked")
        await artifacts.finish()


async def _run_local_job(
    job: Job,
    record: dict[str, object],
    config: JobConfig,
    artifacts: BucketArtifacts,
) -> None:
    run_dir = artifacts.run_dir
    try:
        hook = make_cost_hook(
            cost_ceiling(record),
            len(job),
            run_dir,
            max_retries=config.retry.max_retries,
        )
    except CostCeilingExceeded as error:
        print(str(error), flush=True)
        return

    started, ended = _persistence_hooks(job, artifacts, hook)
    job.on_trial_started(started)
    job.on_trial_ended(ended)
    try:
        await job.run()
    except* ControlledRunStop as errors:
        for trial_name in _interrupted_trial_names(errors):
            cleanup_interrupted_trial(run_dir, trial_name)
            print(f"controlled stop interrupted trial {trial_name}", flush=True)
    except* CostCeilingExceeded as errors:
        for error in errors.exceptions:
            print(str(error), flush=True)


def _persistence_hooks(
    job: Job, artifacts: BucketArtifacts, hook: HookCallback
) -> tuple[HookCallback, HookCallback]:
    run_dir = artifacts.run_dir

    async def started(event: TrialHookEvent) -> None:
        # Same pinned native lock used by Harbor's aggregate writer. Do not
        # snapshot its truncate/write operation or race the local cost check.
        async with artifacts.lock, job._trial_completion_lock:
            await artifacts.refresh_state()
            if _desired_state(run_dir) in {"paused", "cancelled"}:
                raise ControlledRunStop(event.trial_name)
            # First real metadata upload checks write access before inference.
            await artifacts.started(event.trial_name)

    async def ended(event: TrialHookEvent) -> None:
        # Same pinned native lock used by Harbor's aggregate writer. Do not
        # snapshot its truncate/write operation or race the local cost check.
        async with artifacts.lock, job._trial_completion_lock:
            await artifacts.refresh_state()
            try:
                await hook(event)
            except ControlledRunStop:
                cleanup_interrupted_trial(run_dir, event.trial_name)
                raise
            finally:
                await artifacts.trial(
                    event.trial_name,
                    # Do not infer retry attempts or backoff. A failed result in
                    # any retry-enabled run is nonterminal in durable snapshots
                    # until native job completion settles the whole tree.
                    publish_result=(
                        job.config.retry.max_retries == 0
                        or event.result.exception_info is None
                    ),
                )

    return started, ended


def main() -> None:
    asyncio.run(run_parent())


if __name__ == "__main__":
    main()

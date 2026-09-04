"""Run one Harbor job from its immutable Bucket record."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import shutil
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from harbor.job import Job
from harbor.models.job.config import JobConfig
from harbor.models.trial.result import TrialResult
from harbor.trial.hooks import HookCallback, TrialHookEvent
from pydantic import BaseModel, ConfigDict, Field

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


def cost_ceiling(record: dict[str, Any]) -> float:
    """Read the finite positive post-trial ceiling."""
    submission = _record(record.get("submission"), "submission")
    value = submission.get("cost_ceiling_usd_per_trial")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError("cost ceiling must be a number")
    ceiling = float(value)
    if not 0 < ceiling <= 10_000:
        raise ValueError("cost ceiling must be positive")
    return ceiling


def _attempts_dir(run_dir: Path) -> Path:
    return run_dir / "attempt-costs"


def _receipt_for(result: TrialResult) -> AttemptCostReceipt:
    *_, cost = result.compute_token_cost_totals()
    safe_cost = cost if cost is None or math.isfinite(cost) and cost >= 0 else None
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
            receipt = _receipt_for(result)
            _write_receipt(run_dir, receipt)
            receipts.setdefault(receipt.attempt_id, receipt)
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
    receipts: dict[UUID, AttemptCostReceipt], ceiling: float, planned_trials: int
) -> str | None:
    unavailable = next(
        (item for item in receipts.values() if item.cost_usd is None), None
    )
    if unavailable:
        return f"trial {unavailable.trial_name} did not report inference cost"
    expensive = next(
        (
            item
            for item in receipts.values()
            if item.cost_usd is not None and item.cost_usd > ceiling
        ),
        None,
    )
    if expensive:
        return f"trial {expensive.trial_name} reported cost above its ceiling"
    total = sum(item.cost_usd or 0 for item in receipts.values())
    if total > ceiling * planned_trials:
        return "completed trial cost exceeded the run ceiling"
    return None


def make_cost_hook(ceiling: float, planned_trials: int, run_dir: Path) -> HookCallback:
    """Return Harbor's durable post-trial cost callback."""
    if planned_trials <= 0:
        raise ValueError("planned trial count must be positive")
    receipts = load_attempt_costs(run_dir)
    if violation := _cost_violation(receipts, ceiling, planned_trials):
        raise CostCeilingExceeded(violation)

    async def check_cost(event: TrialHookEvent) -> None:
        receipt = _receipt_for(event.result)
        controlled = _desired_state(run_dir) in {"paused", "cancelled"}
        if not controlled or receipt.cost_usd is not None:
            _write_receipt(run_dir, receipt)
            receipts.setdefault(receipt.attempt_id, receipt)
            if violation := _cost_violation(receipts, ceiling, planned_trials):
                raise CostCeilingExceeded(violation)
        if controlled:
            raise ControlledRunStop(receipt.trial_name)

    return check_cost


async def run_parent() -> None:
    """Create Harbor over the mounted job directory and run missing trials."""
    run_id = os.environ.get("HARBOR_HF_RUN_ID", "")
    mount_root = Path(os.environ.get("HARBOR_HF_MOUNT_ROOT", "/data")).resolve()
    record = load_run_record(mount_root, run_id)
    config = job_config(record, mount_root, run_id)
    job = await Job.create(config)
    run_dir = mount_root / "runs" / run_id
    try:
        hook = make_cost_hook(
            cost_ceiling(record),
            len(job),
            run_dir,
        )
    except CostCeilingExceeded as error:
        print(str(error), flush=True)
        return
    job.on_trial_ended(hook)
    try:
        await job.run()
    except* ControlledRunStop as errors:
        for trial_name in _interrupted_trial_names(errors):
            cleanup_interrupted_trial(run_dir, trial_name)
            print(f"controlled stop interrupted trial {trial_name}", flush=True)
    except* CostCeilingExceeded as errors:
        for error in errors.exceptions:
            print(str(error), flush=True)


def main() -> None:
    asyncio.run(run_parent())


if __name__ == "__main__":
    main()

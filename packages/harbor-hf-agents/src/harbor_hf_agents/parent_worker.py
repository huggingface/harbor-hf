"""Run one Harbor job from its immutable Bucket record."""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, cast

from harbor.job import Job
from harbor.models.job.config import JobConfig
from harbor.trial.hooks import HookCallback, TrialHookEvent

_RUN_ID = re.compile(r"^run-[0-9a-f]{24}$")


class CostCeilingExceeded(RuntimeError):
    """Completed trial cost crossed an approved ceiling."""


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


def make_cost_hook(ceiling: float, planned_trials: int) -> HookCallback:
    """Return Harbor's post-trial cost callback."""
    if planned_trials <= 0:
        raise ValueError("planned trial count must be positive")
    completed_cost = 0.0

    async def check_cost(event: TrialHookEvent) -> None:
        nonlocal completed_cost
        *_, cost = event.result.compute_token_cost_totals()
        if cost is None:
            return
        completed_cost += cost
        if cost > ceiling:
            raise CostCeilingExceeded(
                f"trial {event.trial_name} reported cost above its ceiling"
            )
        if completed_cost > ceiling * planned_trials:
            raise CostCeilingExceeded("completed trial cost exceeded the run ceiling")

    return check_cost


async def run_parent() -> None:
    """Create Harbor over the mounted job directory and run missing trials."""
    run_id = os.environ.get("HARBOR_HF_RUN_ID", "")
    mount_root = Path(os.environ.get("HARBOR_HF_MOUNT_ROOT", "/data")).resolve()
    record = load_run_record(mount_root, run_id)
    config = job_config(record, mount_root, run_id)
    job = await Job.create(config)
    job.on_trial_ended(make_cost_hook(cost_ceiling(record), len(job)))
    try:
        await job.run()
    except* CostCeilingExceeded as errors:
        for error in errors.exceptions:
            print(str(error), flush=True)


def main() -> None:
    asyncio.run(run_parent())


if __name__ == "__main__":
    main()

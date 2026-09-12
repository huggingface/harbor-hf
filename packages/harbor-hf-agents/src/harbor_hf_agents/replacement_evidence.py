"""Temporary cross-run evidence checks absent from Harbor at the reviewed pin.

Remove when a reviewed Harbor revision supplies equivalent replacement provenance
and coverage validation. Native models and planning remain authoritative.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from uuid import UUID

from harbor.job_plan import JobPlan
from harbor.models.job.config import JobConfig
from harbor.models.job.lock import JobLock, TrialLock
from harbor.models.job.result import JobResult
from harbor.models.trial.config import TrialConfig
from harbor.models.trial.result import TrialResult
from pydantic import BaseModel

from harbor_hf_agents import launch

RUN_ID = re.compile(r"run-[0-9a-f]{24}")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _json_numbers(value: object) -> object:
    """Choose one representation before Harbor restores its declared field types.

    JSON has no int/float distinction. Normalize only exact integral floats;
    never round fractions, coerce booleans, or pass arbitrary integers via float.
    Normalizing the final native dump instead would change existing fingerprints
    for fields that Harbor explicitly declares as float.
    """
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Replacement evidence requires finite JSON numbers")
        if value.is_integer():
            return int(value)
    if isinstance(value, dict):
        return {key: _json_numbers(item) for key, item in launch.record(value).items()}
    if isinstance(value, list):
        return [_json_numbers(item) for item in objects(value)]
    return value


def native(value: BaseModel) -> dict[str, object]:
    return launch.record(
        _ordered_sets(value.model_dump(mode="json"), value.model_dump(mode="python"))
    )


def _ordered_sets(value: object, python_value: object) -> object:
    if isinstance(python_value, (set, frozenset)):
        return sorted(objects(value), key=canonical)
    if isinstance(value, dict) and isinstance(python_value, dict):
        original = launch.record(python_value)
        return {
            key: _ordered_sets(item, raw)
            for (key, item), raw in zip(
                launch.record(value).items(), original.values(), strict=True
            )
        }
    if isinstance(value, list) and isinstance(python_value, (list, tuple)):
        return [
            _ordered_sets(item, original)
            for item, original in zip(value, python_value, strict=True)
        ]
    return value


def owned_config(config: JobConfig) -> dict[str, object]:
    value = native(config)
    value.pop("job_name")
    value.pop("jobs_dir")
    launch.record(launch.record(value["environment"])["kwargs"]).pop("run_label", None)
    return value


def trial_config(config: TrialConfig) -> dict[str, object]:
    value = native(config)
    for key in ("job_id", "trial_name", "trials_dir"):
        value.pop(key)
    launch.record(launch.record(value["environment"])["kwargs"]).pop("run_label", None)
    return value


def cohort_key(result: TrialResult) -> str:
    return canonical(
        {
            "config": trial_config(result.config),
            "task_id": native(result.task_id),
            "task_name": result.task_name,
            "source": result.source,
            "checksum": result.task_checksum,
        }
    )


def objects(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ValueError("Expected an array")
    return cast(list[object], value)


@dataclass(frozen=True)
class Evidence:
    record: dict[str, object]
    config: JobConfig
    lock: JobLock
    result: JobResult
    trials: list[TrialResult]

    @property
    def run_id(self) -> str:
        return str(self.record["run_id"])

    @classmethod
    def parse(cls, value: object) -> Evidence:
        bundle = launch.record(_json_numbers(value))
        trials = objects(bundle["trials"])
        if any("id" not in launch.record(item) for item in trials):
            raise ValueError("Native trial UUID must be recorded, never generated")
        evidence = cls(
            launch.record(bundle["record"]),
            JobConfig.model_validate(bundle["config"]),
            JobLock.model_validate(bundle["lock"]),
            JobResult.model_validate(bundle["result"]),
            [TrialResult.model_validate(item) for item in trials],
        )
        evidence.validate()
        return evidence

    def validate(self) -> None:
        from harbor_hf_agents.parent_worker import job_config

        if (
            self.record.get("schema_version") != "v1"
            or not RUN_ID.fullmatch(self.run_id)
            or self.record.get("harbor_revision") != launch.REVISION
            or self.lock.harbor.git_commit_hash != launch.REVISION
        ):
            raise ValueError("Source identity or Harbor revision mismatch")
        if (
            not self.config.jobs_dir.is_absolute()
            or len(self.config.jobs_dir.parents) < 2
        ):
            raise ValueError("Source must use an owned absolute job path")
        recorded = job_config(self.record, self.config.jobs_dir.parents[1], self.run_id)
        if native(recorded) != native(self.config):
            raise ValueError("Source record configuration mismatch")
        if len(self.config.agents) != 1 or self.config.is_regrade:
            raise ValueError("Replacement requires a one-agent Cartesian native job")
        self._complete()
        self._coverage()

    def _complete(self) -> None:
        result = self.result
        count = len(self.trials)
        if (
            not result.finished_at
            or not count
            or result.n_total_trials != count
            or result.stats.n_completed_trials != count
            or result.stats.n_pending_trials != 0
            or result.stats.n_running_trials != 0
            or len(self.lock.trials) != count
        ):
            raise ValueError(
                "Source must have complete native results and lock coverage"
            )
        ids = [trial.id for trial in self.trials]
        names = [trial.trial_name for trial in self.trials]
        if len(set(ids)) != count or len(set(names)) != count or self.result.id in ids:
            raise ValueError("Duplicate native trial identity")
        if result.trial_results and Counter(
            canonical(native(t)) for t in result.trial_results
        ) != Counter(canonical(native(t)) for t in self.trials):
            raise ValueError("Native job and per-trial results disagree")
        if (
            self.lock.retry != self.config.retry
            or self.lock.n_concurrent_trials != self.config.n_concurrent_trials
        ):
            raise ValueError("Native job lock configuration mismatch")

    def _coverage(self) -> None:
        remaining = list(self.lock.trials)
        resolved: dict[str, tuple[str, str]] = {}
        for trial in self.trials:
            self._trial(trial)
            match = next(
                (item for item in remaining if lock_matches(item, trial)), None
            )
            if match is None:
                raise ValueError(
                    "Trial task/checksum/config does not match native lock"
                )
            key = canonical(trial_config(trial.config))
            value = (canonical(native(match)), trial.task_checksum)
            if resolved.setdefault(key, value) != value:
                raise ValueError("Ambiguous native task lock/checksum evidence")
            # Native lock equality is content-only; remove the exact matched object.
            remaining = [item for item in remaining if item is not match]

    def _trial(self, trial: TrialResult) -> None:
        if (
            trial.config.job_id != self.result.id
            or not trial.finished_at
            or trial.config.trial_name != trial.trial_name
            or Path(trial.trial_name).name != trial.trial_name
            or trial.trial_name in {"", ".", ".."}
        ):
            raise ValueError("Foreign or unfinished native trial")
        expected = JobPlan.build_trial_configs(
            self.config, [trial.config.task], job_id=self.result.id
        )
        if not expected or trial.config != expected[0]:
            raise ValueError("Non-Cartesian native trial configuration")
        if (
            native(trial.task_id) != native(trial.config.task.get_task_id())
            or trial.source != trial.config.task.source
        ):
            raise ValueError("Native task identity mismatch")

    def select(self, value: object) -> list[TrialResult]:
        ids = [UUID(str(item)) for item in objects(value)]
        if not ids or len(set(ids)) != len(ids):
            raise ValueError("Selection requires distinct native trial UUIDs")
        by_id = {trial.id: trial for trial in self.trials}
        if any(item not in by_id for item in ids):
            raise ValueError("Selected native trial does not exist in source")
        selected = [by_id[item] for item in sorted(ids, key=str)]
        if any(trial.exception_info is None for trial in selected):
            raise ValueError("Selection requires native exception_info, not a reward")
        return selected

    def fingerprint(self, selected: list[TrialResult]) -> str:
        recorded = {**self.record, "harbor_job_config": native(self.config)}
        result = native(self.result)
        # Harbor may omit embedded results from result.json; the full native
        # per-trial evidence below is authoritative and bound in either case.
        result.pop("trial_results")
        lock = native(self.lock)
        lock["trials"] = sorted(objects(lock["trials"]), key=canonical)
        value = {
            "record": recorded,
            "config": native(self.config),
            "lock": lock,
            "result": result,
            "trials": [native(t) for t in sorted(self.trials, key=lambda t: str(t.id))],
            "trial_ids": sorted(str(t.id) for t in selected),
        }
        return "sha256:" + hashlib.sha256(canonical(value).encode()).hexdigest()


def lock_matches(lock: TrialLock, trial: TrialResult) -> bool:
    task = trial.config.task
    # Native locks name task IDs; result names may use Task.name metadata overrides.
    if (
        lock.task.name != trial.task_id.get_name()
        or lock.task.source != trial.source
        or lock.task.path != task.path
        or lock.task.git_url != task.git_url
        or lock.task.git_commit_id != task.git_commit_id
    ):
        return False
    expected_type = (
        "git"
        if task.is_git_task()
        else "package"
        if task.is_package_task()
        else "local"
    )
    if lock.task.type != expected_type or lock.source_trial is not None:
        return False
    values = native(lock)
    config = native(trial.config)
    # Compare every shared native field, not a parallel TrialConfig schema.
    shared = values.keys() & config.keys() - {"task", "verifier", "extra_instructions"}
    if any(values[key] != config[key] for key in shared):
        return False
    verifier = lock.verifier.model_dump(mode="json", exclude={"environment_mode"})
    return (
        verifier == config["verifier"]
        and lock.verifier.environment_mode == trial.verifier_environment_mode
    )


def derive(
    source: Evidence, selected: list[TrialResult], run_id: str, local_root: Path
) -> JobConfig:
    if (
        not RUN_ID.fullmatch(run_id)
        or run_id == source.run_id
        or not local_root.is_absolute()
    ):
        raise ValueError("Replacement requires a future owned run path")
    value = native(source.config)
    value.update(
        tasks=[native(t.config.task) for t in selected],
        datasets=[],
        n_attempts=1,
        job_name="job",
        jobs_dir=str(local_root / "runs" / run_id),
    )
    launch.record(launch.record(value["environment"])["kwargs"])["run_label"] = run_id
    return JobConfig.model_validate(value)

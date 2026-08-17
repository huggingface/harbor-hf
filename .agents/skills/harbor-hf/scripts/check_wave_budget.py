#!/usr/bin/env python3
"""Check whether planned Harbor HF waves fit the execution deadline."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import TypedDict

import yaml


class InputError(ValueError):
    """Raised when a manifest or plan lacks required planning data."""


class _Shard(TypedDict):
    trial_count: int


class _DeploymentGroup(TypedDict):
    deployment: str
    shards: list[_Shard]


def _mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise InputError(f"{label} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise InputError(f"{label} keys must be strings")
    return {str(key): item for key, item in value.items()}


def _sequence(value: object, label: str) -> list[object]:
    if not isinstance(value, list):
        raise InputError(f"{label} must be an array")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise InputError(f"{label} must be a nonempty string")
    return value


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise InputError(f"{label} must be a positive integer")
    return value


def _optional_positive_int(value: object, label: str) -> int | None:
    if value is None:
        return None
    return _positive_int(value, label)


def _load_yaml(path: Path) -> dict[str, object]:
    try:
        raw: object = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise InputError(f"cannot read manifest {path}: {exc}") from exc
    return _mapping(raw, "manifest")


def _load_json(path: Path) -> dict[str, object]:
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"cannot read plan {path}: {exc}") from exc
    return _mapping(raw, "plan")


def _deployment_profiles(manifest: dict[str, object]) -> dict[str, dict[str, object]]:
    matrix = _mapping(manifest.get("matrix"), "manifest.matrix")
    profiles: dict[str, dict[str, object]] = {}
    for index, item in enumerate(
        _sequence(matrix.get("deployments"), "manifest.matrix.deployments")
    ):
        profile = _mapping(item, f"manifest.matrix.deployments[{index}]")
        profile_id = _string(
            profile.get("id"), f"manifest.matrix.deployments[{index}].id"
        )
        if profile_id in profiles:
            raise InputError(f"duplicate deployment id: {profile_id}")
        profiles[profile_id] = profile
    return profiles


def _plan_groups(plan: dict[str, object]) -> dict[str, _DeploymentGroup]:
    groups: dict[str, _DeploymentGroup] = {}
    runs = _sequence(plan.get("runs"), "plan.runs")
    for run_index, item in enumerate(runs):
        run = _mapping(item, f"plan.runs[{run_index}]")
        deployment = _string(
            run.get("deployment"), f"plan.runs[{run_index}].deployment"
        )
        digest = _string(
            run.get("deployment_digest"),
            f"plan.runs[{run_index}].deployment_digest",
        )
        if digest in groups and groups[digest]["deployment"] != deployment:
            raise InputError(
                f"deployment digest {digest} maps to multiple deployment ids"
            )
        group = groups.setdefault(digest, {"deployment": deployment, "shards": []})
        for shard_index, shard_item in enumerate(
            _sequence(run.get("shards"), f"plan.runs[{run_index}].shards")
        ):
            shard = _mapping(
                shard_item, f"plan.runs[{run_index}].shards[{shard_index}]"
            )
            trial_count = len(
                _sequence(
                    shard.get("trials"),
                    f"plan.runs[{run_index}].shards[{shard_index}].trials",
                )
            )
            if trial_count < 1:
                raise InputError(
                    f"plan.runs[{run_index}].shards[{shard_index}] is empty"
                )
            group["shards"].append({"trial_count": trial_count})
    if not groups:
        raise InputError("plan contains no deployment groups")
    return groups


def _provider_request_concurrency(profile: dict[str, object]) -> int | None:
    if profile.get("kind") != "inference-provider":
        return None
    limits = _mapping(profile.get("limits"), "provider deployment limits")
    return _optional_positive_int(
        limits.get("max_concurrent_requests"),
        "provider limits.max_concurrent_requests",
    )


def _validate_plan_identity(
    manifest: dict[str, object],
    plan: dict[str, object],
    groups: dict[str, _DeploymentGroup],
) -> None:
    metadata = _mapping(manifest.get("metadata"), "manifest.metadata")
    experiment = _string(metadata.get("name"), "manifest.metadata.name")
    plan_experiment = _string(plan.get("experiment"), "plan.experiment")
    if experiment != plan_experiment:
        raise InputError(
            "manifest and plan disagree on experiment name: "
            f"{experiment} != {plan_experiment}"
        )

    planned_runs = _sequence(plan.get("runs"), "plan.runs")
    declared_counts = {
        "run_count": len(planned_runs),
        "shard_count": sum(len(group["shards"]) for group in groups.values()),
        "trial_count": sum(
            shard["trial_count"]
            for group in groups.values()
            for shard in group["shards"]
        ),
    }
    for field, calculated in declared_counts.items():
        declared = _positive_int(plan.get(field), f"plan.{field}")
        if declared != calculated:
            raise InputError(
                f"plan.{field} disagrees with plan contents: {declared} != {calculated}"
            )


def build_report(
    *,
    manifest_path: Path,
    plan_path: Path,
    planning_trial_seconds: float,
    reserve_seconds: float,
    headroom_factor: float,
) -> dict[str, object]:
    """Build a deterministic wave feasibility report."""
    if not math.isfinite(planning_trial_seconds) or planning_trial_seconds <= 0:
        raise InputError("planning trial seconds must be finite and positive")
    if not math.isfinite(reserve_seconds) or reserve_seconds < 0:
        raise InputError("reserve seconds must be finite and nonnegative")
    if not math.isfinite(headroom_factor) or headroom_factor < 1:
        raise InputError("headroom factor must be finite and at least 1")

    manifest = _load_yaml(manifest_path)
    plan = _load_json(plan_path)
    execution = _mapping(manifest.get("execution"), "manifest.execution")
    trial_concurrency = _positive_int(
        execution.get("concurrent_trials"), "execution.concurrent_trials"
    )
    timeout_seconds = _positive_int(
        execution.get("timeout_seconds"), "execution.timeout_seconds"
    )
    max_trials_per_shard = _positive_int(
        execution.get("max_trials_per_shard"),
        "execution.max_trials_per_shard",
    )
    manifest_max_shards = _positive_int(
        execution.get("max_shards_per_wave"),
        "execution.max_shards_per_wave",
    )
    plan_max_shards = _positive_int(
        plan.get("max_shards_per_wave"), "plan.max_shards_per_wave"
    )
    if manifest_max_shards != plan_max_shards:
        raise InputError(
            "manifest and plan disagree on max_shards_per_wave: "
            f"{manifest_max_shards} != {plan_max_shards}"
        )

    profiles = _deployment_profiles(manifest)
    groups = _plan_groups(plan)
    _validate_plan_identity(manifest, plan, groups)

    group_reports: list[dict[str, object]] = []
    all_feasible = True
    maximum_estimated_seconds = 0
    total_wave_count = 0

    for digest, group in groups.items():
        deployment = group["deployment"]
        if deployment not in profiles:
            raise InputError(f"plan references unknown deployment: {deployment}")
        provider_concurrency = _provider_request_concurrency(profiles[deployment])
        effective_concurrency = min(
            trial_concurrency,
            provider_concurrency or trial_concurrency,
        )
        denominator = planning_trial_seconds * headroom_factor
        available_work_seconds = max(0.0, timeout_seconds - reserve_seconds)
        max_batches = math.floor(available_work_seconds / denominator)
        max_safe_trials = max_batches * effective_concurrency
        recommended_max_shards = max_safe_trials // max_trials_per_shard
        recommended_max_trials_per_shard = min(max_trials_per_shard, max_safe_trials)

        waves: list[dict[str, object]] = []
        shards = group["shards"]
        for start in range(0, len(shards), plan_max_shards):
            wave_shards = shards[start : start + plan_max_shards]
            trial_count = sum(shard["trial_count"] for shard in wave_shards)
            batches = math.ceil(trial_count / effective_concurrency)
            estimated_work_seconds = batches * planning_trial_seconds
            bounded_estimate_seconds = math.ceil(
                estimated_work_seconds * headroom_factor + reserve_seconds
            )
            feasible = bounded_estimate_seconds <= timeout_seconds
            all_feasible = all_feasible and feasible
            maximum_estimated_seconds = max(
                maximum_estimated_seconds, bounded_estimate_seconds
            )
            waves.append(
                {
                    "wave_index": len(waves) + 1,
                    "shard_count": len(wave_shards),
                    "trial_count": trial_count,
                    "serial_batches": batches,
                    "estimated_work_seconds": estimated_work_seconds,
                    "bounded_estimate_seconds": bounded_estimate_seconds,
                    "timeout_seconds": timeout_seconds,
                    "headroom_seconds": timeout_seconds - bounded_estimate_seconds,
                    "feasible": feasible,
                }
            )

        total_wave_count += len(waves)
        group_reports.append(
            {
                "deployment": deployment,
                "deployment_digest": digest,
                "configured_trial_concurrency": trial_concurrency,
                "provider_request_concurrency": provider_concurrency,
                "effective_concurrency": effective_concurrency,
                "limiting_factor": (
                    "provider_request_concurrency"
                    if provider_concurrency is not None
                    and provider_concurrency < trial_concurrency
                    else "trial_concurrency"
                ),
                "total_shards": len(shards),
                "total_trials": sum(shard["trial_count"] for shard in shards),
                "max_safe_trials_per_wave": max_safe_trials,
                "recommended_max_shards_per_wave": recommended_max_shards,
                "recommended_max_trials_per_shard": (recommended_max_trials_per_shard),
                "waves": waves,
            }
        )

    return {
        "schema_version": "harbor-hf/skill-wave-budget/v1",
        "manifest": str(manifest_path),
        "plan": str(plan_path),
        "assumptions": {
            "planning_trial_seconds": planning_trial_seconds,
            "reserve_seconds": reserve_seconds,
            "headroom_factor": headroom_factor,
            "max_shards_per_wave": plan_max_shards,
            "max_trials_per_shard": max_trials_per_shard,
            "execution_timeout_seconds": timeout_seconds,
        },
        "summary": {
            "all_feasible": all_feasible,
            "deployment_group_count": len(group_reports),
            "wave_count": total_wave_count,
            "maximum_bounded_estimate_seconds": maximum_estimated_seconds,
            "minimum_headroom_seconds": timeout_seconds - maximum_estimated_seconds,
        },
        "deployment_groups": group_reports,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Check planned Harbor HF wave duration against the execution timeout."
        )
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--planning-trial-seconds", type=float, required=True)
    parser.add_argument("--reserve-seconds", type=float, required=True)
    parser.add_argument("--headroom-factor", type=float, required=True)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = build_report(
            manifest_path=args.manifest,
            plan_path=args.plan,
            planning_trial_seconds=args.planning_trial_seconds,
            reserve_seconds=args.reserve_seconds,
            headroom_factor=args.headroom_factor,
        )
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is None:
        sys.stdout.write(rendered)
    else:
        args.output.write_text(rendered, encoding="utf-8")

    summary = _mapping(report["summary"], "report.summary")
    return 0 if summary["all_feasible"] is True else 2


if __name__ == "__main__":
    raise SystemExit(main())

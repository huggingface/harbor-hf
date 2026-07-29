from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import cast

import yaml

ROOT = Path(__file__).parents[1]
SKILL_ROOT = ROOT / "skills" / "harbor-hf"
SCRIPT = SKILL_ROOT / "scripts" / "check_wave_budget.py"


def _object_dict(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    assert all(isinstance(key, str) for key in value)
    return cast(dict[str, object], value)


def _object_list(value: object) -> list[object]:
    assert isinstance(value, list)
    return cast(list[object], value)


def _manifest(*, max_shards_per_wave: int) -> dict[str, object]:
    return {
        "metadata": {"name": "test-campaign"},
        "matrix": {
            "deployments": [
                {
                    "id": "provider",
                    "kind": "inference-provider",
                    "limits": {"max_concurrent_requests": 1},
                }
            ]
        },
        "execution": {
            "concurrent_trials": 16,
            "max_trials_per_shard": 16,
            "max_shards_per_wave": max_shards_per_wave,
            "timeout_seconds": 16_200,
        },
    }


def _plan(
    *, shard_trial_counts: list[int], max_shards_per_wave: int
) -> dict[str, object]:
    return {
        "experiment": "test-campaign",
        "run_count": 1,
        "shard_count": len(shard_trial_counts),
        "trial_count": sum(shard_trial_counts),
        "max_shards_per_wave": max_shards_per_wave,
        "runs": [
            {
                "deployment": "provider",
                "deployment_digest": "sha256:" + "1" * 64,
                "shards": [
                    {"trials": [{} for _ in range(count)]}
                    for count in shard_trial_counts
                ],
            }
        ],
    }


def _run_check(
    tmp_path: Path,
    *,
    manifest: dict[str, object],
    plan: dict[str, object],
) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
    manifest_path = tmp_path / "campaign.yaml"
    plan_path = tmp_path / "plan.json"
    output_path = tmp_path / "report.json"
    manifest_path.write_text(yaml.safe_dump(manifest), encoding="utf-8")
    plan_path.write_text(json.dumps(plan), encoding="utf-8")
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--manifest",
            str(manifest_path),
            "--plan",
            str(plan_path),
            "--planning-trial-seconds",
            "180",
            "--reserve-seconds",
            "900",
            "--headroom-factor",
            "1.25",
            "--output",
            str(output_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    report = (
        _object_dict(json.loads(output_path.read_text()))
        if output_path.exists()
        else None
    )
    return completed, report


def test_skill_has_valid_frontmatter_and_references() -> None:
    skill = SKILL_ROOT / "SKILL.md"
    text = skill.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    frontmatter = yaml.safe_load(text.split("---", 2)[1])
    assert frontmatter == {
        "name": "harbor-hf",
        "description": (
            "Plan, profile, validate, launch, monitor, reconcile, recover, "
            "verify and score Harbor benchmark campaigns, then publish them "
            "through Hugging Face Jobs, Inference Providers, and Inference "
            "Endpoints."
        ),
    }
    for relative_path in (
        "references/planning-and-capacity.md",
        "references/launch-and-monitoring.md",
        "references/recovery.md",
        "references/evidence-and-publication.md",
        "references/provider-agents-and-security.md",
        "references/operator-checklists.md",
        "scripts/check_wave_budget.py",
    ):
        assert (SKILL_ROOT / relative_path).is_file()


def test_wave_budget_rejects_one_oversized_serial_provider_wave(
    tmp_path: Path,
) -> None:
    shard_counts = [16] * 43 + [2]
    completed, report = _run_check(
        tmp_path,
        manifest=_manifest(max_shards_per_wave=44),
        plan=_plan(shard_trial_counts=shard_counts, max_shards_per_wave=44),
    )

    assert completed.returncode == 2
    assert report is not None
    assert report["summary"] == {
        "all_feasible": False,
        "deployment_group_count": 1,
        "maximum_bounded_estimate_seconds": 156_150,
        "minimum_headroom_seconds": -139_950,
        "wave_count": 1,
    }
    group = _object_dict(_object_list(report["deployment_groups"])[0])
    assert group["effective_concurrency"] == 1
    assert group["limiting_factor"] == "provider_request_concurrency"
    assert group["total_trials"] == 690
    assert group["recommended_max_shards_per_wave"] == 4


def test_wave_budget_accepts_bounded_serial_provider_waves(tmp_path: Path) -> None:
    completed, report = _run_check(
        tmp_path,
        manifest=_manifest(max_shards_per_wave=1),
        plan=_plan(shard_trial_counts=[16, 16, 16], max_shards_per_wave=1),
    )

    assert completed.returncode == 0
    assert report is not None
    summary = _object_dict(report["summary"])
    assert summary["all_feasible"] is True
    assert summary["wave_count"] == 3
    group = _object_dict(_object_list(report["deployment_groups"])[0])
    waves = [_object_dict(wave) for wave in _object_list(group["waves"])]
    assert all(wave["bounded_estimate_seconds"] == 4_500 for wave in waves)


def test_wave_budget_rejects_manifest_plan_partition_mismatch(
    tmp_path: Path,
) -> None:
    completed, report = _run_check(
        tmp_path,
        manifest=_manifest(max_shards_per_wave=1),
        plan=_plan(shard_trial_counts=[1], max_shards_per_wave=2),
    )

    assert completed.returncode == 1
    assert report is None
    assert "disagree on max_shards_per_wave" in completed.stderr

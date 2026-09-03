from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from harbor.environments.hf_sandbox import HFSandboxEnvironment

from harbor_hf_agents.hf_sandbox import LabeledHFSandboxEnvironment
from harbor_hf_agents.parent_worker import (
    CostCeilingExceeded,
    cost_ceiling,
    job_config,
    load_run_record,
    make_cost_hook,
)

RUN_ID = "run-0123456789abcdef01234567"


def record(root: Path) -> dict[str, Any]:
    return {
        "schema_version": "v1",
        "run_id": RUN_ID,
        "submission": {"cost_ceiling_usd_per_trial": 0.25},
        "harbor_job_config": {
            "job_name": "job",
            "jobs_dir": str(root / "runs" / RUN_ID),
            "n_attempts": 1,
            "n_concurrent_trials": 1,
            "datasets": [],
            "agents": [{"name": "nop"}],
            "environment": {
                "import_path": (
                    "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment"
                ),
                "kwargs": {"run_label": RUN_ID},
            },
        },
    }


def test_loads_and_validates_the_assigned_record(tmp_path: Path) -> None:
    value = record(tmp_path)
    path = tmp_path / "runs" / RUN_ID / "run.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(value), encoding="utf-8")

    loaded = load_run_record(tmp_path, RUN_ID)
    assert loaded == value
    assert job_config(loaded, tmp_path, RUN_ID).job_name == "job"
    assert cost_ceiling(loaded) == 0.25

    loaded["run_id"] = "run-ffffffffffffffffffffffff"
    path.write_text(json.dumps(loaded), encoding="utf-8")
    with pytest.raises(ValueError, match="identity"):
        load_run_record(tmp_path, RUN_ID)


@pytest.mark.asyncio
async def test_cost_hook_stops_only_after_an_expensive_trial() -> None:
    class Result:
        def __init__(self, cost: float | None) -> None:
            self.cost = cost

        def compute_token_cost_totals(
            self,
        ) -> tuple[None, None, None, float | None]:
            return None, None, None, self.cost

    hook = make_cost_hook(0.25, 2)
    cheap = SimpleNamespace(trial_name="cheap", result=Result(0.25))
    expensive = SimpleNamespace(trial_name="expensive", result=Result(0.26))
    await hook(cast(Any, cheap))
    with pytest.raises(CostCeilingExceeded, match="above its ceiling"):
        await hook(cast(Any, expensive))
    with pytest.raises(ValueError, match="planned trial count"):
        make_cost_hook(0.25, 0)


@pytest.mark.asyncio
async def test_labels_the_child_job(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    async def start(_self: object, _force_build: bool) -> None:
        return None

    monkeypatch.setattr(HFSandboxEnvironment, "start", start)
    monkeypatch.setattr(
        HFSandboxEnvironment,
        "_require_sandbox",
        lambda _self: SimpleNamespace(id="child-job"),
    )
    monkeypatch.setattr(
        "harbor_hf_agents.hf_sandbox.HfApi.update_job_labels",
        lambda _self, **kwargs: calls.append(kwargs),
    )
    environment = object.__new__(LabeledHFSandboxEnvironment)
    environment._run_label = RUN_ID
    await environment.start(False)

    assert calls == [
        {
            "job_id": "child-job",
            "labels": {
                "harbor-hf-role": "trial",
                "harbor-hf-run": RUN_ID,
            },
            "namespace": None,
        }
    ]

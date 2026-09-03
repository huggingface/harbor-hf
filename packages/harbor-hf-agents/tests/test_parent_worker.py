from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import huggingface_hub._sandbox as sandbox_module
import pytest
from harbor.environments.hf_sandbox import HFSandboxEnvironment
from huggingface_hub import HfApi

from harbor_hf_agents.hf_sandbox import (
    LabeledHFSandboxEnvironment,
    _resolve_inference_env,
)
from harbor_hf_agents.parent_worker import (
    CostCeilingExceeded,
    cost_ceiling,
    job_config,
    load_attempt_costs,
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


class Result:
    def __init__(self, trial_name: str, cost: float | None) -> None:
        self.id = uuid4()
        self.trial_name = trial_name
        self.cost = cost

    def compute_token_cost_totals(
        self,
    ) -> tuple[None, None, None, float | None]:
        return None, None, None, self.cost


@pytest.mark.asyncio
async def test_cost_hook_stops_only_after_an_expensive_trial(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    hook = make_cost_hook(0.25, 2, run_dir)
    cheap = SimpleNamespace(result=Result("cheap", 0.25))
    expensive = SimpleNamespace(result=Result("expensive", 0.26))

    await hook(cast(Any, cheap))

    assert len(load_attempt_costs(run_dir)) == 1
    with pytest.raises(CostCeilingExceeded, match="above its ceiling"):
        await hook(cast(Any, expensive))
    assert len(load_attempt_costs(run_dir)) == 2
    with pytest.raises(ValueError, match="planned trial count"):
        make_cost_hook(0.25, 0, run_dir)


@pytest.mark.asyncio
async def test_cost_hook_restores_retry_cost_after_restart(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    first = make_cost_hook(0.25, 1, run_dir)
    await first(cast(Any, SimpleNamespace(result=Result("task", 0.2))))

    resumed = make_cost_hook(0.25, 1, run_dir)
    with pytest.raises(CostCeilingExceeded, match="run ceiling"):
        await resumed(cast(Any, SimpleNamespace(result=Result("task", 0.2))))


@pytest.mark.asyncio
@pytest.mark.parametrize("cost", [None, float("inf"), -1.0])
async def test_cost_hook_fails_closed_when_cost_is_unavailable(
    tmp_path: Path,
    cost: float | None,
) -> None:
    hook = make_cost_hook(0.25, 1, tmp_path / "run")

    with pytest.raises(CostCeilingExceeded, match="did not report inference cost"):
        await hook(cast(Any, SimpleNamespace(result=Result("task", cost))))


@pytest.mark.asyncio
async def test_labels_the_child_job_atomically(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def run_job(
        _self: object,
        *_args: object,
        **kwargs: object,
    ) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(id="child-job")

    async def start(_self: object, _force_build: bool) -> None:
        sandbox_module.HfApi().run_job(
            image="python:3.12",
            command=["sleep", "infinity"],
            labels={"hf-sandbox": "1"},
        )

    monkeypatch.setattr(HfApi, "run_job", run_job)
    monkeypatch.setattr(HFSandboxEnvironment, "start", start)
    monkeypatch.setenv("HARBOR_HF_NAMESPACE", "test-namespace")
    environment = object.__new__(LabeledHFSandboxEnvironment)
    environment._run_label = RUN_ID
    await environment.start(False)

    assert calls == [
        {
            "image": "python:3.12",
            "command": ["sleep", "infinity"],
            "labels": {
                "hf-sandbox": "1",
                "harbor-hf-role": "trial",
                "harbor-hf-run": RUN_ID,
            },
            "namespace": "test-namespace",
        }
    ]


def test_resolves_only_the_fixed_inference_template(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    template = "$" + "{HF_INFERENCE_TOKEN}"
    values = {
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
        "OPENAI_API_KEY": template,
    }
    monkeypatch.setenv("HF_INFERENCE_TOKEN", "inference-test-value")
    assert _resolve_inference_env(values) == {
        "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
        "OPENAI_API_KEY": "inference-test-value",
    }
    assert _resolve_inference_env({"HF_TOKEN": template}) == {
        "HF_TOKEN": "inference-test-value"
    }
    assert values["OPENAI_API_KEY"] == template

    monkeypatch.delenv("HF_INFERENCE_TOKEN")
    with pytest.raises(RuntimeError, match="HF_INFERENCE_TOKEN is required"):
        _resolve_inference_env(values)
    monkeypatch.setenv("HF_INFERENCE_TOKEN", "inference-test-value")
    with pytest.raises(RuntimeError, match="unsupported inference credential"):
        _resolve_inference_env({"OTHER_KEY": template})

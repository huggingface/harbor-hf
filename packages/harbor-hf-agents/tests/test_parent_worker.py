from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock
from uuid import uuid4

import huggingface_hub._sandbox as sandbox_module
import pytest
from harbor.environments.hf_sandbox import HFSandboxEnvironment
from harbor.job import Job
from harbor.models.agent.context import AgentContext
from harbor.models.job.config import JobConfig
from harbor.models.job.result import JobResult
from harbor.models.task.config import EnvironmentConfig as TaskEnvironmentConfig
from harbor.models.trial.config import AgentConfig, TaskConfig, TrialConfig
from harbor.models.trial.paths import TrialPaths
from harbor.models.trial.result import AgentInfo, TrialResult
from harbor.trial.hooks import HookCallback, TrialEvent, TrialHookEvent
from harbor.trial.trial import Trial
from huggingface_hub import HfApi, Sandbox

from harbor_hf_agents.hf_sandbox import (
    LabeledHFSandboxEnvironment,
    _resolve_inference_env,
)
from harbor_hf_agents.parent_worker import (
    ControlledRunStop,
    CostCeiling,
    CostCeilingExceeded,
    _harbor_job_is_terminal,
    cleanup_interrupted_trial,
    cost_ceiling,
    job_config,
    load_attempt_costs,
    load_run_record,
)
from harbor_hf_agents.parent_worker import (
    make_cost_hook as _make_cost_hook,
)

RUN_ID = "run-0123456789abcdef01234567"
CAMPAIGN_CEILING = CostCeiling(usd=0.25, scope="campaign")
LEGACY_TRIAL_CEILING = CostCeiling(usd=0.25, scope="trial")


def make_cost_hook(
    ceiling: float,
    planned_trials: int,
    run_dir: Path,
    *,
    max_retries: int,
) -> HookCallback:
    assert ceiling == CAMPAIGN_CEILING.usd
    return _make_cost_hook(
        CAMPAIGN_CEILING,
        planned_trials,
        run_dir,
        max_retries=max_retries,
    )


def record(root: Path) -> dict[str, Any]:
    return {
        "schema_version": "v1",
        "run_id": RUN_ID,
        "submission": {"cost_ceiling_usd": 0.25},
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
    assert cost_ceiling(loaded) == CAMPAIGN_CEILING

    loaded["submission"] = {"cost_ceiling_usd_per_trial": 0.25}
    assert cost_ceiling(loaded) == LEGACY_TRIAL_CEILING
    loaded["submission"] = {
        "cost_ceiling_usd": 0.25,
        "cost_ceiling_usd_per_trial": 0.25,
    }
    with pytest.raises(ValueError, match="exactly one"):
        cost_ceiling(loaded)

    loaded["run_id"] = "run-ffffffffffffffffffffffff"
    path.write_text(json.dumps(loaded), encoding="utf-8")
    with pytest.raises(ValueError, match="identity"):
        load_run_record(tmp_path, RUN_ID)


class Result:
    def __init__(
        self,
        trial_name: str,
        cost: float | None,
        *,
        agent_started: bool = True,
    ) -> None:
        self.id = uuid4()
        self.trial_name = trial_name
        self.cost = cost
        self.agent_result = SimpleNamespace() if agent_started else None
        self.agent_execution = None
        self.step_results = None

    def compute_token_cost_totals(
        self,
    ) -> tuple[None, None, None, float | None]:
        return None, None, None, self.cost


def write_job_result(
    run_dir: Path,
    *,
    total: int,
    completed: int,
    running: int,
    pending: int,
) -> Path:
    path = run_dir / "job" / "result.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "id": str(uuid4()),
                "started_at": "2026-09-07T00:00:00Z",
                "n_total_trials": total,
                "stats": {
                    "n_completed_trials": completed,
                    "n_running_trials": running,
                    "n_pending_trials": pending,
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def test_native_completion_requires_exact_zero_retry_progress(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    write_job_result(run_dir, total=2, completed=2, running=0, pending=0)

    assert _harbor_job_is_terminal(run_dir, 2, 0)


@pytest.mark.parametrize(
    ("total", "completed", "running", "pending", "planned", "max_retries"),
    [
        (2, 2, 0, 0, 1, 0),
        (2, 1, 0, 0, 2, 0),
        (2, 1, 1, 0, 2, 0),
        (2, 1, 0, 1, 2, 0),
        (1, 1, -1, 1, 1, 0),
        (1, 1, 0, 0, 1, 1),
    ],
)
def test_native_completion_fails_closed_for_unproved_state(
    tmp_path: Path,
    total: int,
    completed: int,
    running: int,
    pending: int,
    planned: int,
    max_retries: int,
) -> None:
    run_dir = tmp_path / "run"
    write_job_result(
        run_dir,
        total=total,
        completed=completed,
        running=running,
        pending=pending,
    )

    assert not _harbor_job_is_terminal(run_dir, planned, max_retries)


def test_native_completion_fails_closed_for_missing_or_malformed_result(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    assert not _harbor_job_is_terminal(run_dir, 1, 0)

    path = run_dir / "job" / "result.json"
    path.parent.mkdir(parents=True)
    path.write_text("not-json", encoding="utf-8")
    assert not _harbor_job_is_terminal(run_dir, 1, 0)


@pytest.mark.asyncio
async def test_cost_hook_stops_after_cumulative_cost_crosses_campaign_ceiling(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    hook = make_cost_hook(0.25, 2, run_dir, max_retries=0)
    first = SimpleNamespace(result=Result("first", 0.1))
    second = SimpleNamespace(result=Result("second", 0.16))

    await hook(cast(Any, first))

    assert len(load_attempt_costs(run_dir)) == 1
    with pytest.raises(CostCeilingExceeded, match="campaign ceiling"):
        await hook(cast(Any, second))
    assert len(load_attempt_costs(run_dir)) == 2
    with pytest.raises(ValueError, match="planned trial count"):
        make_cost_hook(0.25, 0, run_dir, max_retries=0)


@pytest.mark.asyncio
async def test_cost_hook_restores_retry_cost_after_restart(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    first = make_cost_hook(0.25, 1, run_dir, max_retries=0)
    await first(cast(Any, SimpleNamespace(result=Result("task", 0.2))))

    resumed = make_cost_hook(0.25, 1, run_dir, max_retries=0)
    with pytest.raises(CostCeilingExceeded, match="campaign ceiling"):
        await resumed(cast(Any, SimpleNamespace(result=Result("task", 0.2))))


@pytest.mark.asyncio
async def test_cost_hook_records_zero_when_agent_did_not_start(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    hook = make_cost_hook(0.25, 1, run_dir, max_retries=0)

    await hook(
        cast(
            Any,
            SimpleNamespace(result=Result("setup-failure", None, agent_started=False)),
        )
    )

    receipt = next(iter(load_attempt_costs(run_dir).values()))
    assert receipt.cost_usd == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("cost", [None, float("inf"), -1.0])
async def test_campaign_cost_hook_stops_when_cost_is_unavailable(
    tmp_path: Path,
    cost: float | None,
) -> None:
    run_dir = tmp_path / "run"
    hook = make_cost_hook(0.25, 2, run_dir, max_retries=0)

    with pytest.raises(CostCeilingExceeded, match="did not report cost"):
        await hook(cast(Any, SimpleNamespace(result=Result("unknown", cost))))

    receipt = next(iter(load_attempt_costs(run_dir).values()))
    assert receipt.cost_usd is None


@pytest.mark.asyncio
async def test_legacy_trial_ceiling_keeps_unknown_cost_reservation_behavior(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    hook = _make_cost_hook(
        LEGACY_TRIAL_CEILING,
        2,
        run_dir,
        max_retries=0,
    )

    await hook(cast(Any, SimpleNamespace(result=Result("unknown", None))))
    await hook(cast(Any, SimpleNamespace(result=Result("known", 0.24))))

    receipts = {
        receipt.trial_name: receipt for receipt in load_attempt_costs(run_dir).values()
    }
    assert len(receipts) == 2
    assert receipts["unknown"].cost_usd is None
    assert receipts["known"].cost_usd == 0.24


@pytest.mark.asyncio
async def test_cost_hook_allows_final_direct_overage(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    write_job_result(run_dir, total=1, completed=1, running=0, pending=0)
    hook = make_cost_hook(0.25, 1, run_dir, max_retries=0)

    await hook(cast(Any, SimpleNamespace(result=Result("task", 0.26))))

    receipt = next(iter(load_attempt_costs(run_dir).values()))
    assert receipt.cost_usd == 0.26


@pytest.mark.asyncio
async def test_cost_hook_allows_final_unknown_cost(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    write_job_result(run_dir, total=1, completed=1, running=0, pending=0)
    hook = make_cost_hook(0.25, 1, run_dir, max_retries=0)

    await hook(cast(Any, SimpleNamespace(result=Result("task", None))))

    receipt = next(iter(load_attempt_costs(run_dir).values()))
    assert receipt.cost_usd is None


@pytest.mark.asyncio
async def test_existing_overage_allows_only_zero_retry_finalization(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    hook = make_cost_hook(0.25, 1, run_dir, max_retries=0)
    with pytest.raises(CostCeilingExceeded, match="campaign ceiling"):
        await hook(cast(Any, SimpleNamespace(result=Result("task", 0.26))))
    write_job_result(run_dir, total=1, completed=1, running=0, pending=0)

    make_cost_hook(0.25, 1, run_dir, max_retries=0)
    with pytest.raises(CostCeilingExceeded, match="campaign ceiling"):
        make_cost_hook(0.25, 1, run_dir, max_retries=1)


class NoInferenceTrial:
    def __init__(self, config: TrialConfig, result: TrialResult) -> None:
        self.config = config
        self.result = result
        self.hooks: dict[TrialEvent, list[HookCallback]] = {
            event: [] for event in TrialEvent
        }

    def add_hook(self, event: TrialEvent, hook: HookCallback) -> None:
        self.hooks[event].append(hook)

    async def run(self) -> TrialResult:
        for event in (TrialEvent.START, TrialEvent.END):
            hook_event = TrialHookEvent.model_construct(
                event=event,
                task_name=self.result.task_name,
                config=self.config,
                result=self.result,
                lock=cast(Any, None),
                timestamp=datetime.now(UTC),
            )
            for hook in self.hooks[event]:
                await hook(hook_event)
        return self.result


@pytest.mark.asyncio
async def test_pinned_harbor_finalizes_after_the_final_cost_violation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_dir = tmp_path / "run"
    task_dir = tmp_path / "task"
    task_dir.mkdir()
    task = TaskConfig(path=task_dir)
    config = JobConfig(
        job_name="job",
        jobs_dir=run_dir,
        n_attempts=1,
        n_concurrent_trials=1,
        quiet=True,
        tasks=[task],
        agents=[AgentConfig(name="nop")],
    )
    job = await Job.create(config)
    trial_config = cast(Any, job)._trial_configs[0]
    result = TrialResult(
        task_name=task_dir.name,
        trial_name=trial_config.trial_name,
        trial_uri="file://no-inference-trial",
        task_id=task.get_task_id(),
        task_checksum="sha256:" + "0" * 64,
        config=trial_config,
        agent_info=AgentInfo(name="nop", version="test"),
        agent_result=AgentContext(cost_usd=0.26),
    )

    async def create_trial(_config: TrialConfig) -> NoInferenceTrial:
        return NoInferenceTrial(_config, result)

    monkeypatch.setattr(Trial, "create", staticmethod(create_trial))
    job.on_trial_ended(make_cost_hook(0.25, len(job), run_dir, max_retries=0))

    final = await job.run()
    persisted = JobResult.model_validate_json(
        (run_dir / "job" / "result.json").read_text(encoding="utf-8")
    )

    assert final.finished_at is not None
    assert persisted.finished_at == final.finished_at
    assert persisted.stats.n_completed_trials == 1
    assert len(load_attempt_costs(run_dir)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("cost", "agent_started", "receipt_count"),
    [(None, True, 0), (None, False, 0), (0.1, True, 1)],
)
async def test_controlled_stop_keeps_cost_and_removes_terminal_trial(
    tmp_path: Path,
    cost: float | None,
    agent_started: bool,
    receipt_count: int,
) -> None:
    run_dir = tmp_path / "run"
    hook = make_cost_hook(0.25, 1, run_dir, max_retries=0)
    trial_dir = run_dir / "job" / "task"
    trial_dir.mkdir(parents=True)
    (trial_dir / "result.json").write_text("interrupted", encoding="utf-8")
    (run_dir / "job" / "result.json").write_text("interrupted", encoding="utf-8")
    (run_dir / "state.json").write_text(
        json.dumps({"desired_state": "paused"}), encoding="utf-8"
    )

    with pytest.raises(ControlledRunStop, match="controlled stop") as stopped:
        await hook(
            cast(
                Any,
                SimpleNamespace(
                    result=Result("task", cost, agent_started=agent_started)
                ),
            )
        )
    cleanup_interrupted_trial(run_dir, stopped.value.trial_name)

    assert not trial_dir.exists()
    assert not (run_dir / "job" / "result.json").exists()
    assert len(load_attempt_costs(run_dir)) == receipt_count
    make_cost_hook(0.25, 1, run_dir, max_retries=0)


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


@pytest.mark.asyncio
async def test_task_sandbox_creation_does_not_forward_parent_credentials_or_mounts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def create(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace()

    monkeypatch.setattr(Sandbox, "create", create)
    monkeypatch.setenv("HARBOR_HF_NAMESPACE", "test-namespace")
    monkeypatch.setenv("HF_TOKEN", "fixture-control")
    monkeypatch.setenv("HF_INFERENCE_TOKEN", "fixture-inference")
    environment = LabeledHFSandboxEnvironment(
        environment_dir=tmp_path,
        environment_name="test-task",
        session_id="test-session",
        trial_paths=TrialPaths(trial_dir=tmp_path / "trial"),
        task_env_config=TaskEnvironmentConfig(docker_image="python:3.12"),
        run_label=RUN_ID,
    )
    monkeypatch.setattr(environment, "ensure_dirs", AsyncMock())
    monkeypatch.setattr(environment, "_upload_environment_dir_after_start", AsyncMock())
    await environment.start(False)
    assert calls == [
        {
            "image": "python:3.12",
            "flavor": "cpu-basic",
            "idle_timeout": 600,
            "forward_hf_token": False,
        }
    ]

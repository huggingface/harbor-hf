from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from conftest import with_provider_controller

from harbor_hf.campaign_watchdog import (
    CampaignWatchdogError,
    ControllerJob,
    _controller_jobs,
    plan_controller_watchdog,
)
from harbor_hf.campaigns import CampaignLock, build_campaign_lock, build_campaign_plan
from harbor_hf.controller_status import (
    ControllerClaim,
    ControllerProjectionCounts,
    ControllerStatus,
)
from harbor_hf.models import ExperimentSpec
from harbor_hf.provider_models import ProviderTarget

NOW = datetime(2026, 7, 30, tzinfo=UTC)


def _lock(remote_spec: ExperimentSpec) -> CampaignLock:
    model = remote_spec.matrix.models[0]
    provider = ProviderTarget(id="provider-one", model=model.repo)
    agent = remote_spec.matrix.agents[0].model_copy(
        update={
            "import_path": "harbor_hf_agents.openclaw.agent:OpenClawAgent",
            "parameters": {"openclaw_config": {}},
        }
    )
    spec = remote_spec.model_copy(
        update={
            "matrix": remote_spec.matrix.model_copy(
                update={"deployments": [provider], "agents": [agent]}
            )
        }
    )
    spec = with_provider_controller(spec)
    return build_campaign_lock(build_campaign_plan(spec), "campaign-one")


def _status(
    lock: CampaignLock, state: str = "failed-infrastructure", attempt: int = 1
) -> ControllerStatus:
    return ControllerStatus.model_validate(
        {
            "campaign_id": lock.campaign_id,
            "plan_digest": lock.plan_digest,
            "job_id": f"job-{attempt}",
            "attempt": attempt,
            "state": state,
            "heartbeat_at": NOW - timedelta(minutes=20),
            "lease_expires_at": NOW - timedelta(minutes=10),
            "physical_deadline": NOW - timedelta(minutes=5),
            "remaining_seconds": 0,
            "projection": ControllerProjectionCounts(
                logical_trials=1,
                terminal_trials=0,
                active_trials=0,
                physical_executions=0,
            ),
        }
    )


def _claim(lock: CampaignLock, *, live: bool) -> ControllerClaim:
    heartbeat = NOW - timedelta(minutes=1 if live else 20)
    return ControllerClaim(
        campaign_id=lock.campaign_id,
        job_id="job-1",
        plan_digest=lock.plan_digest,
        attempt=1,
        acquired_at=NOW - timedelta(minutes=30),
        heartbeat_at=heartbeat,
        expires_at=NOW + timedelta(minutes=5) if live else NOW - timedelta(minutes=10),
    )


def test_watchdog_recovers_only_stale_infrastructure_failures(
    remote_spec: ExperimentSpec,
) -> None:
    lock = _lock(remote_spec)

    recovery = plan_controller_watchdog(
        lock,
        _status(lock),
        _claim(lock, live=False),
        [ControllerJob(job_id="job-1", stage="ERROR", attempt=1)],
        campaign_terminal=False,
        now=NOW,
    )
    active = plan_controller_watchdog(
        lock,
        _status(lock),
        _claim(lock, live=False),
        [ControllerJob(job_id="job-1", stage="RUNNING", attempt=1)],
        campaign_terminal=False,
        now=NOW,
    )
    claimed = plan_controller_watchdog(
        lock,
        _status(lock),
        _claim(lock, live=True),
        [],
        campaign_terminal=False,
        now=NOW,
    )

    assert recovery.action == "recover"
    assert recovery.replacement_attempt == 2
    assert active.action == "none"
    assert claimed.action == "none"


@pytest.mark.parametrize(
    "state",
    ["paused-capacity", "paused-policy", "failed-deterministic"],
)
def test_watchdog_never_automatically_continues_policy_blocks(
    remote_spec: ExperimentSpec, state: str
) -> None:
    lock = _lock(remote_spec)
    decision = plan_controller_watchdog(
        lock,
        _status(lock, state),
        None,
        [],
        campaign_terminal=False,
        now=NOW,
    )

    assert decision.action == "operator"
    assert state in decision.reason


def test_watchdog_stops_at_the_locked_attempt_limit(
    remote_spec: ExperimentSpec,
) -> None:
    lock = _lock(remote_spec)
    assert lock.controller_policy is not None
    decision = plan_controller_watchdog(
        lock,
        _status(lock, attempt=lock.controller_policy.max_attempts),
        None,
        [],
        campaign_terminal=False,
        now=NOW,
    )

    assert decision.action == "operator"
    assert decision.reason == "controller attempt limit is exhausted"


def test_watchdog_rejects_duplicate_physical_attempt_jobs(
    remote_spec: ExperimentSpec,
) -> None:
    lock = _lock(remote_spec)
    labels = {
        "harbor-hf-role": "campaign-controller",
        "harbor-hf-campaign": lock.campaign_id,
        "harbor-hf-plan": lock.plan_digest.removeprefix("sha256:")[:16],
        "harbor-hf-controller-attempt": "1",
    }

    class Jobs:
        def list_jobs(self, **kwargs: object) -> list[object]:
            del kwargs
            return [
                SimpleNamespace(id="job-one", labels=labels, status="ERROR"),
                SimpleNamespace(id="job-two", labels=labels, status="ERROR"),
            ]

    with pytest.raises(CampaignWatchdogError, match="multiple controller Jobs"):
        _controller_jobs(Jobs(), lock, "org")

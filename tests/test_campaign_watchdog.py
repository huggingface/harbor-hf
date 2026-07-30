from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import cast

import pytest
import yaml
from conftest import with_provider_controller

from harbor_hf.campaign_watchdog import (
    CampaignWatchdogError,
    ControllerJob,
    SnapshotCampaignStore,
    _controller_jobs,
    plan_controller_watchdog,
    run_campaign_watchdog,
)
from harbor_hf.campaigns import CampaignLock, build_campaign_lock, build_campaign_plan
from harbor_hf.control import (
    CampaignSnapshot,
    CampaignSubmittedPayload,
    new_event,
)
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerClaim,
    ControllerLaunchClaim,
    ControllerLaunchReceipt,
    ControllerLaunchUnavailable,
    ControllerProjectionCounts,
    ControllerRecoveryDecision,
    ControllerStateStore,
    ControllerStatus,
)
from harbor_hf.models import ExperimentSpec
from harbor_hf.process import ProcessError
from harbor_hf.provider_models import ProviderTarget

NOW = datetime(2026, 7, 30, tzinfo=UTC)


def _spec(remote_spec: ExperimentSpec) -> ExperimentSpec:
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
    return with_provider_controller(spec)


def _lock(remote_spec: ExperimentSpec) -> CampaignLock:
    return build_campaign_lock(
        build_campaign_plan(_spec(remote_spec)), "campaign-one", clock=lambda: NOW
    )


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


class WatchdogStore:
    def __init__(self, lock: CampaignLock, spec: ExperimentSpec) -> None:
        self.lock = lock
        self.spec = spec
        self.control_commit = "commit-one"
        self.submitted = new_event(
            subject_type="campaign",
            subject_id=lock.campaign_id,
            kind="campaign.submitted",
            producer="cli",
            payload=CampaignSubmittedPayload(plan_digest=lock.plan_digest),
            clock=lambda: NOW,
            identifier=lambda: "1" * 32,
        )

    def load_snapshot(self, campaign_id: str) -> CampaignSnapshot:
        assert campaign_id == self.lock.campaign_id
        return CampaignSnapshot(
            lock=self.lock,
            events=[self.submitted],
            request=yaml.safe_dump(
                self.spec.model_dump(mode="json", exclude_none=True)
            ).encode(),
            control_commit=self.control_commit,
        )


class WatchdogState:
    def __init__(self, lock: CampaignLock, spec: ExperimentSpec) -> None:
        assert spec.remote is not None
        self.lock = lock
        self.status = _status(lock)
        self.attempts = {
            1: ControllerAttemptReservation(
                campaign_id=lock.campaign_id,
                plan_digest=lock.plan_digest,
                input_digest="sha256:" + "2" * 64,
                input_uri="hf://buckets/org/input",
                output_uri="hf://buckets/org/output",
                worker_revision=spec.remote.worker.revision,
                attempt=1,
                reserved_at=NOW - timedelta(hours=1),
            )
        }
        self.recoveries: dict[int, ControllerRecoveryDecision] = {}
        self.launch_claim: ControllerLaunchClaim | None = None
        self.launches: dict[int, ControllerLaunchReceipt] = {}

    def read_status(self, campaign_id: str) -> ControllerStatus:
        assert campaign_id == self.lock.campaign_id
        return self.status

    def read_claim(self, campaign_id: str) -> None:
        assert campaign_id == self.lock.campaign_id
        return None

    def read_attempt(
        self, campaign_id: str, attempt: int
    ) -> ControllerAttemptReservation | None:
        assert campaign_id == self.lock.campaign_id
        return self.attempts.get(attempt)

    def reserve_attempt(self, value: ControllerAttemptReservation) -> None:
        observed = self.attempts.get(value.attempt)
        if observed is not None and observed != value:
            raise AssertionError("attempt changed")
        self.attempts[value.attempt] = value

    def read_recovery(
        self, campaign_id: str, replacement_attempt: int
    ) -> ControllerRecoveryDecision | None:
        assert campaign_id == self.lock.campaign_id
        return self.recoveries.get(replacement_attempt)

    def write_recovery(self, value: ControllerRecoveryDecision) -> None:
        observed = self.recoveries.get(value.replacement_attempt)
        if observed is not None and observed != value:
            raise AssertionError("recovery changed")
        self.recoveries[value.replacement_attempt] = value

    def acquire_launch(self, claim: ControllerLaunchClaim) -> None:
        if (
            self.launch_claim is not None
            and self.launch_claim != claim
            and self.launch_claim.expires_at > claim.acquired_at
        ):
            raise ControllerLaunchUnavailable("launch is in progress")
        self.launch_claim = claim

    def release_launch(self, claim: ControllerLaunchClaim) -> None:
        assert self.launch_claim == claim
        self.launch_claim = None

    def read_launch_claim(
        self, campaign_id: str, attempt: int
    ) -> ControllerLaunchClaim | None:
        del campaign_id, attempt
        return self.launch_claim

    def write_launch(self, receipt: ControllerLaunchReceipt) -> None:
        observed = self.launches.get(receipt.attempt)
        if observed is not None:
            assert observed == receipt
        self.launches[receipt.attempt] = receipt

    def read_launch(
        self, campaign_id: str, attempt: int
    ) -> ControllerLaunchReceipt | None:
        del campaign_id
        return self.launches.get(attempt)


class WatchdogJobs:
    def __init__(self, lock: CampaignLock) -> None:
        self.labels = {
            "harbor-hf-role": "campaign-controller",
            "harbor-hf-campaign": lock.campaign_id,
            "harbor-hf-plan": lock.plan_digest.removeprefix("sha256:")[:16],
            "harbor-hf-controller-attempt": "1",
        }

    def list_jobs(self, **kwargs: object) -> list[object]:
        selected = cast(dict[str, str], kwargs["labels"])
        if "harbor-hf-controller-attempt" in selected:
            return []
        return [SimpleNamespace(id="job-1", labels=self.labels, status="ERROR")]


class FlakyRunner:
    def __init__(self) -> None:
        self.calls = 0

    def run_text(self, command: list[str]) -> str:
        del command
        self.calls += 1
        if self.calls == 1:
            raise ProcessError("launch failed")
        return "submitted " + "b" * 24


def test_watchdog_reuses_recovery_records_after_a_failed_launch(
    remote_spec: ExperimentSpec,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spec = _spec(remote_spec)
    lock = build_campaign_lock(
        build_campaign_plan(spec), "campaign-one", clock=lambda: NOW
    )
    store = WatchdogStore(lock, spec)
    state = WatchdogState(lock, spec)
    jobs = WatchdogJobs(lock)
    runner = FlakyRunner()
    monkeypatch.setenv("GITHUB_TOKEN", "fake-github-token")
    monkeypatch.setenv("OPENAI_API_KEY", "fake-openai-key")

    with pytest.raises(ProcessError, match="launch failed"):
        run_campaign_watchdog(
            lock.campaign_id,
            store=cast(SnapshotCampaignStore, store),
            state_store=cast(ControllerStateStore, state),
            jobs_api=jobs,
            runner=runner,
            clock=lambda: NOW,
        )
    first_recovery = state.recoveries[2]
    first_reservation = state.attempts[2]
    store.control_commit = "commit-two"

    result = run_campaign_watchdog(
        lock.campaign_id,
        store=cast(SnapshotCampaignStore, store),
        state_store=cast(ControllerStateStore, state),
        jobs_api=jobs,
        runner=runner,
        clock=lambda: NOW + timedelta(minutes=31),
    )

    assert result.submission is not None
    assert result.submission.job_id == "b" * 24
    assert state.recoveries[2] == first_recovery
    assert state.attempts[2] == first_reservation
    assert first_recovery.decided_at == first_reservation.reserved_at


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

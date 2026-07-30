from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from harbor_hf.campaigns import CampaignLock
from harbor_hf.control import CampaignSnapshot, CampaignStore
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerClaim,
    ControllerRecoveryDecision,
    ControllerStateStore,
    ControllerStatus,
    ProviderCapacityClaim,
)
from harbor_hf.io import load_experiment_bytes
from harbor_hf.models import CampaignControllerSpec
from harbor_hf.recovery import project_recovery
from harbor_hf.submission import (
    CampaignControllerSubmission,
    ControllerJobsApi,
    TextRunner,
    launch_reserved_campaign_controller,
)

_TERMINAL_JOB_STAGES = {"COMPLETED", "CANCELED", "CANCELLED", "ERROR", "DELETED"}


class CampaignWatchdogError(RuntimeError):
    """Raised when controller recovery evidence is unsafe or incomplete."""


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ControllerJob(FrozenModel):
    job_id: str
    stage: str
    attempt: int = Field(ge=1)

    @property
    def terminal(self) -> bool:
        return self.stage.upper() in _TERMINAL_JOB_STAGES


class WatchdogDecision(FrozenModel):
    action: Literal["none", "recover", "operator"]
    reason: str
    replacement_attempt: int | None = Field(default=None, ge=2)


class WatchdogResult(FrozenModel):
    campaign_id: str
    decision: WatchdogDecision
    submission: CampaignControllerSubmission | None = None


class SnapshotCampaignStore(CampaignStore, Protocol):
    def load_snapshot(self, campaign_id: str) -> CampaignSnapshot: ...


def plan_controller_watchdog(
    lock: CampaignLock,
    status: ControllerStatus | None,
    claim: ControllerClaim | None,
    jobs: list[ControllerJob],
    *,
    campaign_terminal: bool,
    now: datetime,
) -> WatchdogDecision:
    policy = lock.controller_policy
    if policy is None:
        return WatchdogDecision(action="none", reason="campaign uses no controller")
    if campaign_terminal or (status is not None and status.state == "completed"):
        return WatchdogDecision(action="none", reason="campaign is terminal")
    active = [job for job in jobs if not job.terminal]
    if active:
        return WatchdogDecision(action="none", reason="controller Job is active")
    if claim is not None and claim.expires_at > now.astimezone(UTC):
        return WatchdogDecision(action="none", reason="controller claim is still valid")
    return _status_recovery_decision(policy, status)


def _status_recovery_decision(
    policy: CampaignControllerSpec,
    status: ControllerStatus | None,
) -> WatchdogDecision:
    if status is None:
        return WatchdogDecision(
            action="operator", reason="controller has no durable status"
        )
    if status.state in {
        "paused-capacity",
        "paused-policy",
        "failed-deterministic",
    }:
        return WatchdogDecision(
            action="operator",
            reason=f"controller state requires approval: {status.state}",
        )
    if status.attempt >= policy.max_attempts:
        return WatchdogDecision(
            action="operator", reason="controller attempt limit is exhausted"
        )
    retryable_states = {
        "starting",
        "running",
        "waiting-retry",
        "finalizing",
        "failed-infrastructure",
    }
    if status.state not in retryable_states:
        return WatchdogDecision(
            action="operator",
            reason="controller outcome is not retryable infrastructure",
        )
    return WatchdogDecision(
        action="recover",
        reason="prior controller is terminal or absent and its claim is stale",
        replacement_attempt=status.attempt + 1,
    )


def run_campaign_watchdog(
    campaign_id: str,
    *,
    store: SnapshotCampaignStore,
    state_store: ControllerStateStore,
    jobs_api: ControllerJobsApi,
    runner: TextRunner,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    dry_run: bool = False,
) -> WatchdogResult:
    snapshot = store.load_snapshot(campaign_id)
    spec = load_experiment_bytes(snapshot.request, source="campaign request")
    projection = project_recovery(snapshot.lock, snapshot.events)
    status = state_store.read_status(campaign_id)
    claim = state_store.read_claim(campaign_id)
    jobs = _controller_jobs(
        jobs_api, snapshot.lock, spec.remote.job.namespace if spec.remote else ""
    )
    if not dry_run:
        _release_abandoned_provider_capacity(
            snapshot.lock,
            state_store,
            jobs,
        )
    decision = plan_controller_watchdog(
        snapshot.lock,
        status,
        claim,
        jobs,
        campaign_terminal=projection.status
        in {"completed", "partial", "failed", "cancelled"},
        now=clock(),
    )
    if decision.action != "recover" or dry_run:
        return WatchdogResult(campaign_id=campaign_id, decision=decision)
    if status is None or decision.replacement_attempt is None:
        raise CampaignWatchdogError("watchdog recovery has no prior controller status")
    prior = state_store.read_attempt(campaign_id, status.attempt)
    if prior is None:
        raise CampaignWatchdogError(
            "watchdog recovery has no immutable launch contract"
        )
    replacement_attempt = decision.replacement_attempt
    existing_recovery = state_store.read_recovery(campaign_id, replacement_attempt)
    existing_replacement = state_store.read_attempt(campaign_id, replacement_attempt)
    recorded_at = (
        existing_recovery.decided_at
        if existing_recovery is not None
        else (
            existing_replacement.reserved_at
            if existing_replacement is not None
            else clock().astimezone(UTC)
        )
    )
    replacement = ControllerAttemptReservation(
        **prior.model_dump(
            mode="python",
            exclude={"attempt", "reserved_at"},
        ),
        attempt=replacement_attempt,
        reserved_at=recorded_at,
    )
    recovery = ControllerRecoveryDecision(
        campaign_id=campaign_id,
        plan_digest=snapshot.lock.plan_digest,
        prior_job_id=status.job_id,
        prior_attempt=status.attempt,
        replacement_attempt=replacement_attempt,
        checkpoint_revision=(
            existing_recovery.checkpoint_revision
            if existing_recovery is not None
            else snapshot.control_commit
        ),
        category="lost",
        decided_at=recorded_at,
    )
    if existing_recovery is not None and existing_recovery != recovery:
        raise CampaignWatchdogError(
            "watchdog recovery decision conflicts with the campaign state"
        )
    if existing_replacement is not None and existing_replacement != replacement:
        raise CampaignWatchdogError(
            "watchdog replacement attempt conflicts with the launch contract"
        )
    state_store.write_recovery(recovery)
    state_store.reserve_attempt(replacement)
    submission = launch_reserved_campaign_controller(
        snapshot.lock,
        spec,
        replacement,
        runner=runner,
        jobs_api=jobs_api,
        state_store=state_store,
        clock=clock,
    )
    return WatchdogResult(
        campaign_id=campaign_id,
        decision=decision,
        submission=submission,
    )


def _release_abandoned_provider_capacity(
    lock: CampaignLock,
    state_store: ControllerStateStore,
    jobs: list[ControllerJob],
) -> None:
    active_job_ids = {job.job_id for job in jobs if not job.terminal}
    providers = sorted({run.provider for run in lock.runs if run.provider is not None})
    for provider in providers:
        claim = state_store.read_provider_capacity(provider)
        if not _capacity_is_abandoned(claim, lock.campaign_id, active_job_ids):
            continue
        assert claim is not None
        state_store.release_provider_capacity(claim)


def _capacity_is_abandoned(
    claim: ProviderCapacityClaim | None,
    campaign_id: str,
    active_job_ids: set[str],
) -> bool:
    return (
        claim is not None
        and claim.campaign_id == campaign_id
        and claim.job_id not in active_job_ids
    )


def _controller_jobs(
    api: ControllerJobsApi,
    lock: CampaignLock,
    namespace: str,
) -> list[ControllerJob]:
    if not namespace:
        raise CampaignWatchdogError("campaign watchdog requires remote settings")
    labels = {
        "harbor-hf-role": "campaign-controller",
        "harbor-hf-campaign": lock.campaign_id,
        "harbor-hf-plan": lock.plan_digest.removeprefix("sha256:")[:16],
    }
    resources: Iterable[object] = api.list_jobs(labels=labels, namespace=namespace)
    jobs: list[ControllerJob] = []
    seen_attempts: set[int] = set()
    for resource in resources:
        job = _controller_job(resource, labels)
        if job.attempt in seen_attempts:
            raise CampaignWatchdogError(
                "multiple controller Jobs have one physical attempt identity"
            )
        seen_attempts.add(job.attempt)
        jobs.append(job)
    return sorted(jobs, key=lambda job: job.attempt)


def _controller_job(value: object, expected: Mapping[str, str]) -> ControllerJob:
    identifier = getattr(value, "id", None)
    labels = getattr(value, "labels", None)
    status = getattr(value, "status", None)
    stage_value = getattr(status, "stage", status)
    stage = getattr(stage_value, "value", stage_value)
    if not isinstance(identifier, str) or not identifier:
        raise CampaignWatchdogError("controller Job has no ID")
    if not isinstance(labels, Mapping) or any(
        labels.get(key) != item for key, item in expected.items()
    ):
        raise CampaignWatchdogError("controller Job labels do not match the campaign")
    attempt_value = labels.get("harbor-hf-controller-attempt")
    if not isinstance(attempt_value, str) or not attempt_value.isdigit():
        raise CampaignWatchdogError("controller Job has no valid attempt label")
    if not isinstance(stage, str) or not stage:
        raise CampaignWatchdogError("controller Job has no stage")
    return ControllerJob(job_id=identifier, stage=stage, attempt=int(attempt_value))

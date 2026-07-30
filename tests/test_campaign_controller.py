import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
import yaml
from conftest import with_provider_controller

from harbor_hf.campaign_apply import CampaignReconciler
from harbor_hf.campaign_controller import (
    CampaignController,
    CampaignControllerError,
    InProcessWaveExecutor,
)
from harbor_hf.campaign_input import validate_campaign_input, write_campaign_input
from harbor_hf.campaigns import CampaignLock, build_campaign_lock, build_campaign_plan
from harbor_hf.control import (
    CampaignEvent,
    CampaignStore,
    CampaignSubmittedPayload,
    TerminalPayload,
    new_event,
)
from harbor_hf.controller_status import (
    ControllerAttemptReservation,
    ControllerClaim,
    ControllerEndedReceipt,
    ControllerRecoveryDecision,
    ControllerStartedReceipt,
    ControllerStateStore,
    ControllerStatus,
    ProviderCapacityClaim,
    ProviderCapacityUnavailable,
)
from harbor_hf.models import ExperimentSpec
from harbor_hf.provider_models import ProviderTarget
from harbor_hf.reconciler import ReconcileContext

NOW = datetime(2026, 7, 30, tzinfo=UTC)


def _provider_spec(remote_spec: ExperimentSpec) -> ExperimentSpec:
    model = remote_spec.matrix.models[0]
    target = ProviderTarget(id="provider-one", model=model.repo)
    agent = remote_spec.matrix.agents[0].model_copy(
        update={
            "import_path": "harbor_hf_agents.openclaw.agent:OpenClawAgent",
            "parameters": {"openclaw_config": {}},
        }
    )
    return with_provider_controller(
        remote_spec.model_copy(
            update={
                "matrix": remote_spec.matrix.model_copy(
                    update={"deployments": [target], "agents": [agent]}
                )
            }
        )
    )


class MemoryCampaignStore:
    def __init__(self, lock: CampaignLock, request: bytes) -> None:
        self.lock = lock
        self.request = request
        self.events: list[CampaignEvent] = [
            new_event(
                subject_type="campaign",
                subject_id=lock.campaign_id,
                kind="campaign.submitted",
                producer="cli",
                payload=CampaignSubmittedPayload(plan_digest=lock.plan_digest),
                clock=lambda: NOW,
                identifier=lambda: "1" * 32,
            )
        ]

    def load_campaign(
        self, campaign_id: str
    ) -> tuple[CampaignLock, list[CampaignEvent]]:
        assert campaign_id == self.lock.campaign_id
        return self.lock, list(self.events)


class CompletingReconciler:
    def __init__(self, store: MemoryCampaignStore) -> None:
        self.store = store
        self.calls = 0
        self.refresh_calls = 0

    def refresh_observation(self, campaign_id: str) -> None:
        assert campaign_id == self.store.lock.campaign_id
        self.refresh_calls += 1

    def apply_campaign(
        self,
        campaign_id: str,
        *,
        context: ReconcileContext | None = None,
        expected_action_id: str | None = None,
    ) -> object:
        assert context is not None and context.limits.action_limit == 1
        assert expected_action_id is not None
        self.calls += 1
        self.store.events.append(
            new_event(
                subject_type="campaign",
                subject_id=campaign_id,
                kind="campaign.completed",
                producer="reconciler",
                payload=TerminalPayload(message="verified test completion"),
                clock=lambda: NOW + timedelta(seconds=1),
                identifier=lambda: "2" * 32,
            )
        )
        return SimpleNamespace(applied=[SimpleNamespace()])


class CancellingReconciler(CompletingReconciler):
    def apply_campaign(
        self,
        campaign_id: str,
        *,
        context: ReconcileContext | None = None,
        expected_action_id: str | None = None,
    ) -> object:
        assert context is not None and context.limits.action_limit == 1
        assert expected_action_id is not None
        self.calls += 1
        self.store.events.append(
            new_event(
                subject_type="campaign",
                subject_id=campaign_id,
                kind="campaign.cancelled",
                producer="wave-controller",
                payload=TerminalPayload(message="operator cancellation drained"),
                clock=lambda: NOW + timedelta(seconds=1),
                identifier=lambda: "3" * 32,
            )
        )
        return SimpleNamespace(applied=[SimpleNamespace()])


class FailingReconciler(CompletingReconciler):
    def apply_campaign(
        self,
        campaign_id: str,
        *,
        context: ReconcileContext | None = None,
        expected_action_id: str | None = None,
    ) -> object:
        del campaign_id, context, expected_action_id
        self.calls += 1
        raise RuntimeError("unexpected controller defect")


class MemoryControllerStateStore:
    def __init__(self) -> None:
        self.claim: ControllerClaim | None = None
        self.status: ControllerStatus | None = None
        self.started: list[ControllerStartedReceipt] = []
        self.ended: list[ControllerEndedReceipt] = []
        self.attempts: dict[int, ControllerAttemptReservation] = {}
        self.recoveries: list[ControllerRecoveryDecision] = []
        self.provider_claims: dict[str, ProviderCapacityClaim] = {}
        self.recovered_providers: list[str] = []

    def acquire(self, claim: ControllerClaim, *, prior_job_terminal: bool) -> None:
        del prior_job_terminal
        if self.claim is not None:
            raise AssertionError("duplicate controller claim")
        self.claim = claim

    def heartbeat(self, previous: ControllerClaim, renewed: ControllerClaim) -> None:
        assert self.claim == previous
        self.claim = renewed

    def release(self, claim: ControllerClaim) -> None:
        assert self.claim == claim
        self.claim = None

    def read_claim(self, campaign_id: str) -> ControllerClaim | None:
        del campaign_id
        return self.claim

    def read_status(self, campaign_id: str) -> ControllerStatus | None:
        del campaign_id
        return self.status

    def write_status(self, status: ControllerStatus) -> None:
        self.status = status

    def acquire_provider_capacity(self, claim: ProviderCapacityClaim) -> None:
        observed = self.provider_claims.get(claim.provider)
        if observed is not None and observed != claim:
            raise ProviderCapacityUnavailable("shared provider capacity is occupied")
        self.provider_claims[claim.provider] = claim

    def release_provider_capacity(self, claim: ProviderCapacityClaim) -> None:
        assert self.provider_claims.get(claim.provider) == claim
        del self.provider_claims[claim.provider]

    def recover_provider_capacity(
        self,
        provider: str,
        replacement: ControllerClaim,
        *,
        prior_job_terminal: bool,
    ) -> None:
        self.recovered_providers.append(provider)
        observed = self.provider_claims.get(provider)
        if (
            observed is not None
            and observed.campaign_id == replacement.campaign_id
            and observed.attempt < replacement.attempt
            and prior_job_terminal
        ):
            del self.provider_claims[provider]

    def read_provider_capacity(self, provider: str) -> ProviderCapacityClaim | None:
        return self.provider_claims.get(provider)

    def write_started(self, receipt: ControllerStartedReceipt) -> None:
        self.started.append(receipt)

    def write_ended(self, receipt: ControllerEndedReceipt) -> None:
        self.ended.append(receipt)

    def reserve_attempt(self, reservation: ControllerAttemptReservation) -> None:
        self.attempts[reservation.attempt] = reservation

    def read_attempt(
        self, campaign_id: str, attempt: int
    ) -> ControllerAttemptReservation | None:
        del campaign_id
        return self.attempts.get(attempt)

    def write_recovery(self, decision: ControllerRecoveryDecision) -> None:
        self.recoveries.append(decision)

    def read_recovery(
        self, campaign_id: str, replacement_attempt: int
    ) -> ControllerRecoveryDecision | None:
        return next(
            (
                decision
                for decision in self.recoveries
                if decision.campaign_id == campaign_id
                and decision.replacement_attempt == replacement_attempt
            ),
            None,
        )


class BusyOnceStateStore(MemoryControllerStateStore):
    def __init__(self) -> None:
        super().__init__()
        self.capacity_attempts = 0

    def acquire_provider_capacity(self, claim: ProviderCapacityClaim) -> None:
        self.capacity_attempts += 1
        if self.capacity_attempts == 1:
            raise ProviderCapacityUnavailable("shared provider capacity is occupied")
        super().acquire_provider_capacity(claim)


class FailingStartStateStore(MemoryControllerStateStore):
    def write_started(self, receipt: ControllerStartedReceipt) -> None:
        del receipt
        raise OSError("start receipt unavailable")


class FailingPrepareExecutor:
    def __init__(self, state: MemoryControllerStateStore) -> None:
        self.state = state
        self.observed_state: str | None = None

    def prepare(self, source: object) -> None:
        del source
        assert self.state.status is not None
        self.observed_state = self.state.status.state
        raise OSError("source preparation failed")


class PreparedWaveExecutor:
    def __init__(self) -> None:
        self.prepared: list[object] = []

    def prepare(self, source: object) -> None:
        self.prepared.append(source)


def _runtime(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> tuple[
    MemoryCampaignStore,
    MemoryControllerStateStore,
    CompletingReconciler,
    PreparedWaveExecutor,
    object,
]:
    spec = _provider_spec(remote_spec)
    lock = build_campaign_lock(
        build_campaign_plan(spec),
        "controller-campaign",
        clock=lambda: NOW,
    )
    request = yaml.safe_dump(spec.model_dump(mode="json", exclude_none=True)).encode()
    input_root = tmp_path / "input"
    input_manifest = write_campaign_input(input_root, request=request, lock=lock)
    validated = validate_campaign_input(input_root)
    store = MemoryCampaignStore(lock, request)
    state = MemoryControllerStateStore()
    assert spec.remote is not None
    state.reserve_attempt(
        ControllerAttemptReservation(
            campaign_id=lock.campaign_id,
            plan_digest=lock.plan_digest,
            input_digest=input_manifest.input_digest,
            input_uri="hf://buckets/org/input",
            output_uri="hf://buckets/org/output",
            worker_revision=spec.remote.worker.revision,
            attempt=1,
            reserved_at=NOW,
        )
    )
    reconciler = CompletingReconciler(store)
    executor = PreparedWaveExecutor()
    return store, state, reconciler, executor, validated


def _controller(
    tmp_path: Path,
    store: MemoryCampaignStore,
    state: MemoryControllerStateStore,
    reconciler: CompletingReconciler,
    executor: PreparedWaveExecutor,
    validated: object,
    *,
    attempt: int,
    max_iterations: int | None = None,
) -> CampaignController:
    from harbor_hf.campaign_input import ValidatedCampaignInput

    return CampaignController(
        store=cast(CampaignStore, store),
        state_store=cast(ControllerStateStore, state),
        reconciler=cast(CampaignReconciler, reconciler),
        wave_executor=cast(InProcessWaveExecutor, executor),
        validated_input=cast(ValidatedCampaignInput, validated),
        output_root=tmp_path / "output",
        job_id=f"job-{attempt}",
        attempt=attempt,
        prior_job_terminal=attempt > 1,
        clock=lambda: NOW,
        monotonic=lambda: 100.0,
        sleep=lambda _seconds: None,
        max_iterations=max_iterations,
    )


def test_controller_runs_without_a_local_loop_and_writes_terminal_receipts(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, reconciler, executor, validated = _runtime(tmp_path, remote_spec)

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    ).run()

    assert result.state == "completed"
    assert result.iterations == 2
    assert reconciler.calls == 1
    assert reconciler.refresh_calls == 2
    assert len(executor.prepared) == 1
    assert [receipt.attempt for receipt in state.started] == [1]
    assert [receipt.state for receipt in state.ended] == ["completed"]
    assert state.claim is None


def test_controller_waits_for_shared_provider_capacity_before_running(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, original_state, reconciler, executor, validated = _runtime(
        tmp_path, remote_spec
    )
    state = BusyOnceStateStore()
    state.attempts = original_state.attempts

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    ).run()

    assert result.state == "completed"
    assert result.iterations == 3
    assert state.capacity_attempts == 2
    assert state.provider_claims == {}
    assert reconciler.calls == 1


def test_controller_pauses_when_observed_trial_duration_breaks_the_lock(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, reconciler, executor, validated = _runtime(tmp_path, remote_spec)
    events = (
        tmp_path
        / "output"
        / store.lock.artifact_prefix
        / "runs/run/trials/trial/executions/execution/events.jsonl"
    )
    events.parent.mkdir(parents=True)
    events.write_text(
        "\n".join(
            json.dumps(value)
            for value in (
                {"event": "execution_started", "at": NOW.isoformat()},
                {
                    "event": "execution_succeeded",
                    "at": (NOW + timedelta(seconds=2)).isoformat(),
                },
            )
        )
        + "\n",
        encoding="utf-8",
    )

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    ).run()

    assert result.state == "paused-capacity"
    assert reconciler.calls == 0
    assert state.status is not None
    assert state.status.capacity is not None
    assert not state.status.capacity.assumptions_valid
    assert state.status.capacity.p95_trial_seconds == 2.0


def test_interrupted_attempt_can_resume_in_one_sequential_replacement(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, reconciler, executor, validated = _runtime(tmp_path, remote_spec)
    first = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
        max_iterations=0,
    ).run()
    first_reservation = state.attempts[1]
    state.reserve_attempt(
        first_reservation.model_copy(
            update={"attempt": 2, "reserved_at": NOW + timedelta(minutes=1)}
        )
    )

    second = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=2,
    ).run()

    assert first.state == "failed-infrastructure"
    assert second.state == "completed"
    assert reconciler.calls == 1
    assert [receipt.attempt for receipt in state.started] == [1, 2]
    assert [receipt.attempt for receipt in state.ended] == [1, 2]


def test_controller_persists_starting_status_before_source_preparation(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, reconciler, _executor, validated = _runtime(tmp_path, remote_spec)
    executor = FailingPrepareExecutor(state)

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        cast(PreparedWaveExecutor, executor),
        validated,
        attempt=1,
    ).run()

    assert executor.observed_state == "starting"
    assert result.state == "failed-infrastructure"
    assert result.message == "source preparation failed"
    assert reconciler.calls == 0
    assert state.claim is None


def test_controller_releases_claim_when_start_receipt_fails(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, original_state, reconciler, executor, validated = _runtime(
        tmp_path, remote_spec
    )
    state = FailingStartStateStore()
    state.attempts = original_state.attempts

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    ).run()

    assert result.state == "failed-infrastructure"
    assert result.message == "start receipt unavailable"
    assert state.claim is None
    assert state.started == []
    assert [receipt.state for receipt in state.ended] == ["failed-infrastructure"]
    assert reconciler.calls == 0


def test_controller_drains_one_action_then_honors_campaign_cancellation(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, _reconciler, executor, validated = _runtime(tmp_path, remote_spec)
    reconciler = CancellingReconciler(store)

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    ).run()

    assert result.state == "completed"
    assert reconciler.calls == 1
    assert [receipt.state for receipt in state.ended] == ["completed"]
    assert state.claim is None


def test_controller_signal_stops_before_admitting_another_action(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, reconciler, executor, validated = _runtime(tmp_path, remote_spec)
    controller = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    )
    controller.request_stop()

    result = controller.run()

    assert result.state == "failed-infrastructure"
    assert result.message == "controller received a termination signal"
    assert reconciler.calls == 0
    assert len(executor.prepared) == 1
    assert state.claim is None


def test_unexpected_controller_exception_is_durable_infrastructure_evidence(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, _reconciler, executor, validated = _runtime(tmp_path, remote_spec)
    reconciler = FailingReconciler(store)

    result = _controller(
        tmp_path,
        store,
        state,
        reconciler,
        executor,
        validated,
        attempt=1,
    ).run()

    assert result.state == "failed-infrastructure"
    assert result.message == "unexpected controller defect"
    assert [receipt.state for receipt in state.ended] == ["failed-infrastructure"]
    assert state.claim is None


def test_controller_rejects_an_unreserved_attempt_before_claiming(
    tmp_path: Path,
    remote_spec: ExperimentSpec,
) -> None:
    store, state, reconciler, executor, validated = _runtime(tmp_path, remote_spec)

    with pytest.raises(CampaignControllerError, match="was not reserved"):
        _controller(
            tmp_path,
            store,
            state,
            reconciler,
            executor,
            validated,
            attempt=2,
        ).run()
    assert state.claim is None

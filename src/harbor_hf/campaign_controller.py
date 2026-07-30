from __future__ import annotations

import os
import signal
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict

from harbor_hf.campaign_apply import (
    ActionExecutionError,
    AppliedAction,
    CampaignReconciler,
    RemoteWaveJob,
    WaveJobPort,
)
from harbor_hf.campaign_input import ValidatedCampaignInput, validate_campaign_input
from harbor_hf.campaigns import (
    CampaignLock,
    ProviderWaveTarget,
    WaveLock,
    planned_provider_wave_seconds,
)
from harbor_hf.control import CampaignStore
from harbor_hf.controller_admission import RemainingTimeInput, decide_remaining_time
from harbor_hf.controller_status import (
    ControllerClaim,
    ControllerEndedReceipt,
    ControllerProjectionCounts,
    ControllerStartedReceipt,
    ControllerState,
    ControllerStateStore,
    ControllerStatus,
    ControllerStatusError,
)
from harbor_hf.models import RemoteExecutionSpec
from harbor_hf.process import CommandRunner, SubprocessRunner
from harbor_hf.reconciler import BlockedAction, ReconcileAction, plan_reconciliation
from harbor_hf.recovery import RecoveryProjection, project_recovery
from harbor_hf.wave_worker import run_provider_wave_execution
from harbor_hf.worker import WorkerError, prepare_locked_source


class CampaignControllerError(RuntimeError):
    """Raised when a campaign controller cannot continue safely."""


class Clock(Protocol):
    def __call__(self) -> datetime: ...


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CampaignControllerResult(FrozenModel):
    campaign_id: str
    job_id: str
    attempt: int
    state: ControllerState
    iterations: int
    message: str | None = None


class _IterationResult(FrozenModel):
    state: ControllerState
    finished: bool = False
    message: str | None = None


class EndpointRejectingPort:
    def inspect(self, _desired: object) -> None:
        return None

    def create_or_adopt(self, _desired: object) -> None:
        raise ActionExecutionError(
            "provider campaign controllers cannot provision inference endpoints"
        )

    def pause_and_verify(self, _desired: object) -> None:
        raise ActionExecutionError(
            "provider campaign controllers cannot manage inference endpoints"
        )


class InProcessWaveExecutor(WaveJobPort):
    """Run provider waves synchronously in the owning controller process."""

    def __init__(
        self,
        *,
        manifest_path: Path,
        campaign: CampaignLock,
        output_root: Path,
        staging_root: Path,
        job_id: str,
        runner: CommandRunner | None = None,
    ) -> None:
        self.manifest_path = manifest_path
        self.campaign = campaign
        self.output_root = output_root
        self.staging_root = staging_root
        self.job_id = job_id
        self.runner = runner or SubprocessRunner()
        self.harbor_source = (
            staging_root
            / "sources"
            / f"harbor-{campaign.plan_digest.removeprefix('sha256:')[:16]}"
        )
        self._jobs: dict[str, RemoteWaveJob] = {}

    def prepare(self, source: object) -> None:
        from harbor_hf.models import SourcePin

        pin = SourcePin.model_validate(source)
        prepare_locked_source(pin, self.harbor_source, self.runner)

    def find_wave(
        self,
        *,
        namespace: str,
        wave_id: str,
        endpoint_label: str,
        target_label_key: Literal[
            "harbor-hf-endpoint", "harbor-hf-provider"
        ] = "harbor-hf-endpoint",
    ) -> RemoteWaveJob | None:
        del namespace
        observed = self._jobs.get(wave_id)
        if observed is not None:
            return observed
        root = self.output_root / self.campaign.artifact_prefix / "waves" / wave_id
        stage: str | None = None
        if (root / "_SUCCESS").is_file():
            stage = "COMPLETED"
        elif (root / "_FAILED").is_file() or (root / "_CANCELLED").is_file():
            stage = "ERROR"
        if stage is None:
            return None
        return RemoteWaveJob(
            job_id=self.job_id,
            wave_id=wave_id,
            endpoint_label=endpoint_label,
            target_label_key=target_label_key,
            stage=stage,
        )

    def submit(
        self,
        lock: WaveLock,
        *,
        request: bytes,
        campaign: CampaignLock,
    ) -> RemoteWaveJob:
        del request
        if campaign != self.campaign or not isinstance(lock.target, ProviderWaveTarget):
            raise ActionExecutionError(
                "in-process wave execution accepts only its provider campaign"
            )
        stage = "COMPLETED"
        try:
            run_provider_wave_execution(
                self.manifest_path,
                campaign,
                lock,
                self.output_root,
                self.staging_root,
                self.harbor_source,
                runner=self.runner,
            )
        except WorkerError:
            # The wave runner publishes terminal failure evidence before raising.
            stage = "ERROR"
        job = RemoteWaveJob(
            job_id=self.job_id,
            wave_id=lock.wave_id,
            endpoint_label=lock.target.provider.service,
            target_label_key="harbor-hf-provider",
            stage=stage,
        )
        self._jobs[lock.wave_id] = job
        return job

    def cancel(self, job: RemoteWaveJob, *, namespace: str) -> None:
        del namespace
        if not job.terminal:
            raise ActionExecutionError(
                "an active in-process wave must drain through controller cancellation"
            )


class _Heartbeat:
    def __init__(
        self,
        store: ControllerStateStore,
        claim: ControllerClaim,
        *,
        interval_seconds: int,
        stale_after_seconds: int,
        clock: Clock,
    ) -> None:
        self.store = store
        self._claim = claim
        self.interval_seconds = interval_seconds
        self.stale_after_seconds = stale_after_seconds
        self.clock = clock
        self.stop_event = threading.Event()
        self.lost_event = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(
            target=self._run,
            name=f"campaign-heartbeat-{claim.campaign_id}",
            daemon=True,
        )

    @property
    def claim(self) -> ControllerClaim:
        with self._lock:
            return self._claim

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self._thread.join(timeout=max(1, self.interval_seconds * 2))

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval_seconds):
            previous = self.claim
            now = self.clock().astimezone(UTC)
            renewed = previous.model_copy(
                update={
                    "heartbeat_at": now,
                    "expires_at": now + timedelta(seconds=self.stale_after_seconds),
                }
            )
            try:
                self.store.heartbeat(previous, renewed)
            except Exception:
                self.lost_event.set()
                return
            with self._lock:
                self._claim = renewed


class CampaignController:
    def __init__(
        self,
        *,
        store: CampaignStore,
        state_store: ControllerStateStore,
        reconciler: CampaignReconciler,
        wave_executor: InProcessWaveExecutor,
        validated_input: ValidatedCampaignInput,
        output_root: Path,
        job_id: str,
        attempt: int,
        prior_job_terminal: bool = False,
        clock: Clock = lambda: datetime.now(UTC),
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        max_iterations: int | None = None,
    ) -> None:
        self.store = store
        self.state_store = state_store
        self.reconciler = reconciler
        self.wave_executor = wave_executor
        self.input = validated_input
        self.output_root = output_root
        self.job_id = job_id
        self.attempt = attempt
        self.prior_job_terminal = prior_job_terminal
        self.clock = clock
        self.monotonic = monotonic
        self.sleep = sleep
        self.max_iterations = max_iterations
        self.stop_requested = threading.Event()

    def request_stop(self) -> None:
        self.stop_requested.set()

    def run(self) -> CampaignControllerResult:
        lock = self.input.lock
        policy = lock.controller_policy
        if policy is None or self.input.spec.remote is None:
            raise CampaignControllerError(
                "campaign controller requires a provider controller lock"
            )
        if self.attempt > policy.max_attempts:
            raise CampaignControllerError("controller attempt limit is exhausted")
        self._validate_attempt_reservation(lock)
        started_at = self.clock().astimezone(UTC)
        started_monotonic = self.monotonic()
        claim = ControllerClaim(
            campaign_id=lock.campaign_id,
            job_id=self.job_id,
            plan_digest=lock.plan_digest,
            attempt=self.attempt,
            acquired_at=started_at,
            heartbeat_at=started_at,
            expires_at=started_at + timedelta(seconds=policy.stale_after_seconds),
        )
        self.state_store.acquire(claim, prior_job_terminal=self.prior_job_terminal)
        self.state_store.write_started(
            ControllerStartedReceipt(
                campaign_id=lock.campaign_id,
                plan_digest=lock.plan_digest,
                input_digest=self.input.manifest.input_digest,
                worker_revision=self.input.spec.remote.worker.revision,
                job_id=self.job_id,
                attempt=self.attempt,
                started_at=started_at,
            )
        )
        self.wave_executor.prepare(self.input.spec.remote.harbor.source)
        heartbeat = _Heartbeat(
            self.state_store,
            claim,
            interval_seconds=policy.heartbeat_seconds,
            stale_after_seconds=policy.stale_after_seconds,
            clock=self.clock,
        )
        heartbeat.start()
        state: ControllerState = "starting"
        message: str | None = None
        iterations = 0
        try:
            state, message, iterations = self._drive(
                heartbeat,
                started_at=started_at,
                started_monotonic=started_monotonic,
                heartbeat_seconds=policy.heartbeat_seconds,
            )
        except CampaignControllerError as error:
            state = "failed-infrastructure"
            message = str(error)
        except (OSError, ValueError, ControllerStatusError) as error:
            state = "failed-deterministic"
            message = str(error)
        finally:
            heartbeat.stop()
            self._finish_attempt(
                heartbeat.claim,
                state,
                message,
                started_at=started_at,
                started_monotonic=started_monotonic,
            )
        return CampaignControllerResult(
            campaign_id=lock.campaign_id,
            job_id=self.job_id,
            attempt=self.attempt,
            state=state,
            iterations=iterations,
            message=message,
        )

    def _validate_attempt_reservation(self, lock: CampaignLock) -> None:
        reservation = self.state_store.read_attempt(lock.campaign_id, self.attempt)
        remote = self._remote()
        if reservation is None:
            raise CampaignControllerError("controller attempt was not reserved")
        if (
            reservation.plan_digest != lock.plan_digest
            or reservation.input_digest != self.input.manifest.input_digest
            or reservation.worker_revision != remote.worker.revision
        ):
            raise CampaignControllerError(
                "controller attempt reservation does not match its immutable input"
            )

    def _drive(
        self,
        heartbeat: _Heartbeat,
        *,
        started_at: datetime,
        started_monotonic: float,
        heartbeat_seconds: int,
    ) -> tuple[ControllerState, str | None, int]:
        iterations = 0
        while True:
            if self.max_iterations is not None and iterations >= self.max_iterations:
                raise CampaignControllerError("controller iteration limit reached")
            iterations += 1
            result = self._run_iteration(
                heartbeat,
                started_at=started_at,
                started_monotonic=started_monotonic,
            )
            if result.finished:
                return result.state, result.message, iterations
            if result.state == "waiting-retry":
                self.sleep(min(5.0, float(heartbeat_seconds)))

    def _run_iteration(
        self,
        heartbeat: _Heartbeat,
        *,
        started_at: datetime,
        started_monotonic: float,
    ) -> _IterationResult:
        if heartbeat.lost_event.is_set():
            return _IterationResult(
                state="failed-infrastructure",
                finished=True,
                message="controller ownership heartbeat failed",
            )
        lock, events = self.store.load_campaign(self.input.lock.campaign_id)
        projection, plan = plan_reconciliation(lock, events, now=self.clock())
        terminal = _terminal_controller_state(projection)
        if terminal is not None:
            return _IterationResult(state=terminal, finished=True)
        if self.stop_requested.is_set():
            return _IterationResult(
                state="failed-infrastructure",
                finished=True,
                message="controller received a termination signal",
            )
        action = plan.actions[0] if plan.actions else None
        admission = self._admit_action(
            lock,
            action,
            started_monotonic=started_monotonic,
        )
        paused_state: ControllerState | None = None
        if admission == "paused-capacity":
            paused_state = "paused-capacity"
        elif admission == "paused-policy":
            paused_state = "paused-policy"
        if paused_state is not None:
            message = "controller admission stopped new work"
            self._write_status(
                heartbeat.claim,
                paused_state,
                projection,
                started_at,
                started_monotonic,
                block_reason=message,
            )
            return _IterationResult(
                state=paused_state,
                finished=True,
                message=message,
            )
        state = _action_state(action)
        self._write_status(
            heartbeat.claim,
            state,
            projection,
            started_at,
            started_monotonic,
            action=action,
        )
        applied = self.reconciler.apply_campaign(lock.campaign_id).applied
        return _result_after_apply(applied, plan.blocked, state)

    def _finish_attempt(
        self,
        claim: ControllerClaim,
        state: ControllerState,
        message: str | None,
        *,
        started_at: datetime,
        started_monotonic: float,
    ) -> None:
        try:
            lock, events = self.store.load_campaign(claim.campaign_id)
            projection = project_recovery(lock, events)
            self._write_status(
                claim,
                state,
                projection,
                started_at,
                started_monotonic,
                block_reason=message,
            )
            self.state_store.write_ended(
                ControllerEndedReceipt(
                    campaign_id=lock.campaign_id,
                    plan_digest=lock.plan_digest,
                    job_id=self.job_id,
                    attempt=self.attempt,
                    state=state,
                    ended_at=self.clock().astimezone(UTC),
                    message=message,
                )
            )
        finally:
            self.state_store.release(claim)

    def _admit_action(
        self,
        lock: CampaignLock,
        action: ReconcileAction | None,
        *,
        started_monotonic: float,
    ) -> Literal["admit", "wait", "finalize", "paused-capacity", "paused-policy"]:
        if action is None or action.kind not in {"submit-wave", "retry-shard"}:
            return "finalize" if action is None else "admit"
        planned_seconds = _planned_action_seconds(lock, action)
        remote = self._remote()
        policy = lock.controller_policy
        if policy is None:
            raise CampaignControllerError("provider action has no controller policy")
        decision = decide_remaining_time(
            RemainingTimeInput(
                physical_started_monotonic=started_monotonic,
                physical_timeout_seconds=remote.job.timeout_seconds,
                monotonic_now=self.monotonic(),
                controller_reserve_seconds=policy.controller_reserve_seconds,
                planned_next_wave_seconds=planned_seconds,
                work_remaining=True,
            )
        )
        if decision.decision == "pause-capacity":
            return "paused-capacity"
        if decision.decision == "pause-policy":
            return "paused-policy"
        return decision.decision

    def _write_status(
        self,
        claim: ControllerClaim,
        state: ControllerState,
        projection: RecoveryProjection,
        started_at: datetime,
        started_monotonic: float,
        *,
        action: ReconcileAction | None = None,
        block_reason: str | None = None,
    ) -> None:
        now = self.clock().astimezone(UTC)
        elapsed = max(0, int(self.monotonic() - started_monotonic))
        timeout = self._remote().job.timeout_seconds
        self.state_store.write_status(
            ControllerStatus(
                campaign_id=claim.campaign_id,
                plan_digest=claim.plan_digest,
                job_id=claim.job_id,
                attempt=claim.attempt,
                state=state,
                heartbeat_at=max(now, claim.heartbeat_at),
                lease_expires_at=max(
                    claim.expires_at,
                    now + timedelta(seconds=1),
                ),
                physical_deadline=started_at + timedelta(seconds=timeout),
                remaining_seconds=max(0, timeout - elapsed),
                projection=_projection_counts(projection),
                current_action=action.action_id if action is not None else None,
                current_wave=action.wave_id if action is not None else None,
                spend_reserved_microusd=projection.spend_microusd,
                block_reason=block_reason,
            )
        )

    def _remote(self) -> RemoteExecutionSpec:
        remote = self.input.spec.remote
        if remote is None:
            raise CampaignControllerError("campaign controller has no remote settings")
        return remote


def run_campaign_controller(
    manifest_path: Path,
    campaign_lock_path: Path,
    output_root: Path,
    *,
    attempt: int,
    prior_job_terminal: bool = False,
) -> CampaignControllerResult:
    if manifest_path.parent != campaign_lock_path.parent:
        raise CampaignControllerError("controller input files must share one directory")
    validated = validate_campaign_input(manifest_path.parent)
    remote = validated.spec.remote
    if remote is None:
        raise CampaignControllerError("campaign controller has no remote settings")
    token_name = remote.job.token_secret_name
    token = os.environ.get(token_name, "")
    job_id = os.environ.get("JOB_ID", "")
    if not token:
        raise CampaignControllerError(f"required secret {token_name} is not available")
    if not job_id:
        raise CampaignControllerError("campaign controller requires JOB_ID")

    from harbor_hf.campaign_apply import hugging_face_campaign_reconciler
    from harbor_hf.control import HubCampaignStore
    from harbor_hf.controller_status import HubControllerStateStore

    store = HubCampaignStore(remote.job.namespace)
    state_store = HubControllerStateStore(remote.job.namespace, token)
    with tempfile.TemporaryDirectory(prefix="harbor-hf-controller-") as staging_name:
        executor = InProcessWaveExecutor(
            manifest_path=manifest_path,
            campaign=validated.lock,
            output_root=output_root,
            staging_root=Path(staging_name),
            job_id=job_id,
        )
        with hugging_face_campaign_reconciler(
            remote.job.namespace,
            store=store,
            jobs=executor,
        ) as reconciler:
            controller = CampaignController(
                store=store,
                state_store=state_store,
                reconciler=reconciler,
                wave_executor=executor,
                validated_input=validated,
                output_root=output_root,
                job_id=job_id,
                attempt=attempt,
                prior_job_terminal=prior_job_terminal,
            )
            _install_signal_handlers(controller)
            return controller.run()


def _install_signal_handlers(controller: CampaignController) -> None:
    def request_stop(_signum: int, _frame: object) -> None:
        controller.request_stop()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)


def _result_after_apply(
    applied: list[AppliedAction],
    blocked: list[BlockedAction],
    state: ControllerState,
) -> _IterationResult:
    if applied:
        return _IterationResult(state=state)
    reasons = {item.reason for item in blocked}
    policy_reasons = reasons - {"backoff"}
    if policy_reasons:
        return _IterationResult(
            state="paused-policy",
            finished=True,
            message=", ".join(sorted(policy_reasons)),
        )
    return _IterationResult(state="waiting-retry")


def _projection_counts(projection: RecoveryProjection) -> ControllerProjectionCounts:
    terminal = {"complete", "invalid", "failed_infrastructure", "cancelled"}
    return ControllerProjectionCounts(
        logical_trials=len(projection.trials),
        terminal_trials=sum(
            trial.status in terminal for trial in projection.trials.values()
        ),
        active_trials=sum(
            trial.status == "active" for trial in projection.trials.values()
        ),
        physical_executions=len(projection.executions),
    )


def _terminal_controller_state(
    projection: RecoveryProjection,
) -> ControllerState | None:
    if projection.status in {"completed", "cancelled"}:
        return "completed"
    if projection.status in {"partial", "failed"}:
        return "failed-deterministic"
    return None


def _action_state(action: ReconcileAction | None) -> ControllerState:
    if action is None:
        return "finalizing"
    if action.kind in {"publish-results", "publish-summary"}:
        return "finalizing"
    return "running"


def _planned_action_seconds(lock: CampaignLock, action: ReconcileAction) -> int:
    policy = lock.controller_policy
    if policy is None:
        raise CampaignControllerError("provider action has no controller policy")
    if action.kind == "submit-wave":
        requested = set(action.shard_ids)
        matches = [
            wave for wave in lock.initial_waves if set(wave.shard_ids) == requested
        ]
        if len(matches) != 1:
            raise CampaignControllerError(
                "provider action does not match one locked initial wave"
            )
        return matches[0].planned_duration_seconds
    if action.kind != "retry-shard":
        raise CampaignControllerError("action is not billable provider work")
    concurrency = {
        wave.effective_concurrency
        for wave in lock.initial_waves
        if wave.deployment_digest == action.deployment_digest
    }
    if len(concurrency) != 1:
        raise CampaignControllerError("retry action has no locked concurrency")
    return planned_provider_wave_seconds(
        policy,
        trial_count=len(action.trial_ids),
        effective_concurrency=concurrency.pop(),
    )

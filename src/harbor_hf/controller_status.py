from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, cast

from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi
from huggingface_hub.errors import HfHubHTTPError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from harbor_hf.coordination import coordination_repository

_MAX_COMMIT_ATTEMPTS = 8
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ControllerStatusError(RuntimeError):
    """Raised when controller state cannot be changed safely."""


class ControllerOwnershipConflict(ControllerStatusError):
    """Raised when another physical Job owns the campaign controller."""


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ControllerClaim(FrozenModel):
    schema_version: Literal["harbor-hf/controller-claim/v1alpha1"] = (
        "harbor-hf/controller-claim/v1alpha1"
    )
    campaign_id: str
    job_id: str
    plan_digest: str
    attempt: int = Field(ge=1)
    acquired_at: datetime
    heartbeat_at: datetime
    expires_at: datetime

    @field_validator("campaign_id", "job_id")
    @classmethod
    def identity_is_safe(cls, value: str) -> str:
        if _SAFE_ID.fullmatch(value) is None:
            raise ValueError("controller identities must be safe path components")
        return value

    @field_validator("acquired_at", "heartbeat_at", "expires_at")
    @classmethod
    def timestamp_is_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("controller timestamps must use UTC")
        return value

    @model_validator(mode="after")
    def lease_times_are_ordered(self) -> ControllerClaim:
        if not (self.acquired_at <= self.heartbeat_at < self.expires_at):
            raise ValueError("controller claim timestamps are not ordered")
        return self


class ControllerCapacityEvidence(FrozenModel):
    completed_trial_count: int = Field(ge=1)
    elapsed_seconds: int = Field(ge=0)
    observed_effective_concurrency: int = Field(ge=1)
    p50_trial_seconds: float = Field(ge=0)
    p95_trial_seconds: float = Field(ge=0)
    maximum_trial_seconds: float = Field(ge=0)
    remaining_trials: int = Field(ge=0)
    projected_remaining_seconds: int = Field(ge=0)
    available_seconds: int = Field(ge=0)
    assumptions_valid: bool


class ControllerProjectionCounts(FrozenModel):
    logical_trials: int = Field(ge=0)
    terminal_trials: int = Field(ge=0)
    active_trials: int = Field(ge=0)
    physical_executions: int = Field(ge=0)

    @model_validator(mode="after")
    def counts_are_consistent(self) -> ControllerProjectionCounts:
        if self.terminal_trials + self.active_trials > self.logical_trials:
            raise ValueError("controller projection counts are inconsistent")
        return self


ControllerState = Literal[
    "starting",
    "running",
    "waiting-retry",
    "finalizing",
    "completed",
    "paused-capacity",
    "paused-policy",
    "failed-infrastructure",
    "failed-deterministic",
]


class ControllerStatus(FrozenModel):
    schema_version: Literal["harbor-hf/controller-status/v1alpha1"] = (
        "harbor-hf/controller-status/v1alpha1"
    )
    campaign_id: str
    plan_digest: str
    job_id: str
    attempt: int = Field(ge=1)
    state: ControllerState
    heartbeat_at: datetime
    lease_expires_at: datetime
    physical_deadline: datetime
    remaining_seconds: int = Field(ge=0)
    projection: ControllerProjectionCounts
    current_action: str | None = Field(default=None, min_length=1)
    current_wave: str | None = Field(default=None, min_length=1)
    spend_reserved_microusd: int = Field(default=0, ge=0)
    block_reason: str | None = Field(default=None, min_length=1)
    event_revision: str | None = Field(default=None, min_length=1)
    evidence_revision: str | None = Field(default=None, min_length=1)
    capacity: ControllerCapacityEvidence | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @field_validator("campaign_id", "job_id")
    @classmethod
    def identity_is_safe(cls, value: str) -> str:
        if _SAFE_ID.fullmatch(value) is None:
            raise ValueError("controller identities must be safe path components")
        return value

    @field_validator("heartbeat_at", "lease_expires_at", "physical_deadline")
    @classmethod
    def timestamp_is_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("controller timestamps must use UTC")
        return value

    @model_validator(mode="after")
    def status_times_are_ordered(self) -> ControllerStatus:
        if self.heartbeat_at >= self.lease_expires_at:
            raise ValueError("controller status lease must extend beyond its heartbeat")
        return self


class ControllerStartedReceipt(FrozenModel):
    schema_version: Literal["harbor-hf/controller-started/v1alpha1"] = (
        "harbor-hf/controller-started/v1alpha1"
    )
    campaign_id: str
    plan_digest: str
    input_digest: str
    worker_revision: str
    job_id: str
    attempt: int = Field(ge=1)
    started_at: datetime

    @field_validator("started_at")
    @classmethod
    def started_at_is_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("controller receipt timestamps must use UTC")
        return value


class ControllerEndedReceipt(FrozenModel):
    schema_version: Literal["harbor-hf/controller-ended/v1alpha1"] = (
        "harbor-hf/controller-ended/v1alpha1"
    )
    campaign_id: str
    plan_digest: str
    job_id: str
    attempt: int = Field(ge=1)
    state: ControllerState
    ended_at: datetime
    message: str | None = Field(default=None, min_length=1)

    @field_validator("ended_at")
    @classmethod
    def ended_at_is_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("controller receipt timestamps must use UTC")
        return value


class ControllerAttemptReservation(FrozenModel):
    schema_version: Literal["harbor-hf/controller-attempt/v1alpha1"] = (
        "harbor-hf/controller-attempt/v1alpha1"
    )
    campaign_id: str
    plan_digest: str
    input_digest: str
    input_uri: str = Field(pattern=r"^hf://buckets/[^\s]+$")
    output_uri: str = Field(pattern=r"^hf://buckets/[^\s]+$")
    worker_revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    attempt: int = Field(ge=1)
    reserved_at: datetime

    @field_validator("reserved_at")
    @classmethod
    def reserved_at_is_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("controller reservation timestamps must use UTC")
        return value


class ControllerRecoveryDecision(FrozenModel):
    schema_version: Literal["harbor-hf/controller-recovery/v1alpha1"] = (
        "harbor-hf/controller-recovery/v1alpha1"
    )
    campaign_id: str
    plan_digest: str
    prior_job_id: str
    prior_attempt: int = Field(ge=1)
    replacement_attempt: int = Field(ge=2)
    checkpoint_revision: str
    category: Literal["lost", "transient", "quota", "rate-limit", "ambiguous"]
    decided_at: datetime

    @field_validator("decided_at")
    @classmethod
    def decided_at_is_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("controller recovery timestamps must use UTC")
        return value

    @model_validator(mode="after")
    def attempts_are_sequential(self) -> ControllerRecoveryDecision:
        if self.replacement_attempt != self.prior_attempt + 1:
            raise ValueError("controller replacement attempts must be sequential")
        return self


class ControllerRepositoryApi(Protocol):
    def repo_info(self, repo_id: str, **kwargs: object) -> object: ...

    def get_paths_info(
        self, repo_id: str, paths: str | list[str], **kwargs: object
    ) -> list[object]: ...

    def hf_hub_download(self, repo_id: str, filename: str, **kwargs: object) -> str: ...

    def create_commit(
        self, repo_id: str, operations: list[object], **kwargs: object
    ) -> object: ...


class ControllerStateStore(Protocol):
    def acquire(self, claim: ControllerClaim, *, prior_job_terminal: bool) -> None: ...

    def heartbeat(
        self, previous: ControllerClaim, renewed: ControllerClaim
    ) -> None: ...

    def release(self, claim: ControllerClaim) -> None: ...

    def read_claim(self, campaign_id: str) -> ControllerClaim | None: ...

    def read_status(self, campaign_id: str) -> ControllerStatus | None: ...

    def write_status(self, status: ControllerStatus) -> None: ...

    def write_started(self, receipt: ControllerStartedReceipt) -> None: ...

    def write_ended(self, receipt: ControllerEndedReceipt) -> None: ...

    def reserve_attempt(self, reservation: ControllerAttemptReservation) -> None: ...

    def read_attempt(
        self, campaign_id: str, attempt: int
    ) -> ControllerAttemptReservation | None: ...

    def write_recovery(self, decision: ControllerRecoveryDecision) -> None: ...

    def read_recovery(
        self, campaign_id: str, replacement_attempt: int
    ) -> ControllerRecoveryDecision | None: ...


class HubControllerStateStore:
    """Parent-checked controller records in the private coordination Dataset."""

    def __init__(
        self,
        namespace: str,
        token: str,
        *,
        api: ControllerRepositoryApi | None = None,
    ) -> None:
        self.repository = coordination_repository(namespace)
        self.token = token
        self.api = api or cast(ControllerRepositoryApi, HfApi(token=token))

    def acquire(self, claim: ControllerClaim, *, prior_job_terminal: bool) -> None:
        path = controller_claim_path(claim.campaign_id)
        for _attempt in range(_MAX_COMMIT_ATTEMPTS):
            head = self._head()
            observed = self._read_optional(path, head, ControllerClaim)
            if observed is not None:
                if observed == claim:
                    return
                expired = observed.expires_at <= claim.acquired_at
                if not expired or not prior_job_terminal:
                    raise ControllerOwnershipConflict(
                        "another physical Job owns the campaign controller"
                    )
                if claim.attempt != observed.attempt + 1:
                    raise ControllerStatusError(
                        "replacement controller attempt is not sequential"
                    )
            try:
                self._commit(
                    head,
                    [self._add(path, claim)],
                    f"chore: acquire controller {claim.campaign_id}",
                )
                return
            except HfHubHTTPError as error:
                if not _is_parent_conflict(error):
                    raise
        raise ControllerStatusError("controller claim remained contended")

    def heartbeat(self, previous: ControllerClaim, renewed: ControllerClaim) -> None:
        if (
            previous.campaign_id,
            previous.job_id,
            previous.plan_digest,
            previous.attempt,
            previous.acquired_at,
        ) != (
            renewed.campaign_id,
            renewed.job_id,
            renewed.plan_digest,
            renewed.attempt,
            renewed.acquired_at,
        ) or renewed.heartbeat_at <= previous.heartbeat_at:
            raise ControllerStatusError("controller heartbeat identity is invalid")
        self._replace_exact(
            controller_claim_path(previous.campaign_id),
            previous,
            renewed,
            "chore: renew campaign controller",
        )

    def release(self, claim: ControllerClaim) -> None:
        path = controller_claim_path(claim.campaign_id)
        for _attempt in range(_MAX_COMMIT_ATTEMPTS):
            head = self._head()
            observed = self._read_optional(path, head, ControllerClaim)
            if observed is None:
                return
            if observed != claim:
                raise ControllerStatusError(
                    "controller claim ownership cannot be verified"
                )
            try:
                self._commit(
                    head,
                    [CommitOperationDelete(path_in_repo=path)],
                    f"chore: release controller {claim.campaign_id}",
                )
                return
            except HfHubHTTPError as error:
                if not _is_parent_conflict(error):
                    raise
        raise ControllerStatusError("controller claim remained contended")

    def read_claim(self, campaign_id: str) -> ControllerClaim | None:
        head = self._head()
        return self._read_optional(
            controller_claim_path(campaign_id), head, ControllerClaim
        )

    def read_status(self, campaign_id: str) -> ControllerStatus | None:
        head = self._head()
        return self._read_optional(
            controller_status_path(campaign_id), head, ControllerStatus
        )

    def write_status(self, status: ControllerStatus) -> None:
        path = controller_status_path(status.campaign_id)
        for _attempt in range(_MAX_COMMIT_ATTEMPTS):
            head = self._head()
            observed = self._read_optional(path, head, ControllerStatus)
            if observed is not None:
                if observed == status:
                    return
                if (
                    observed.campaign_id != status.campaign_id
                    or observed.plan_digest != status.plan_digest
                    or status.attempt < observed.attempt
                    or (
                        status.attempt == observed.attempt
                        and observed.job_id != status.job_id
                    )
                    or status.heartbeat_at < observed.heartbeat_at
                ):
                    raise ControllerStatusError("controller status moved backwards")
            try:
                self._commit(
                    head, [self._add(path, status)], "chore: update controller status"
                )
                return
            except HfHubHTTPError as error:
                if not _is_parent_conflict(error):
                    raise
        raise ControllerStatusError("controller status remained contended")

    def write_started(self, receipt: ControllerStartedReceipt) -> None:
        self._write_immutable(
            controller_started_path(receipt), receipt, "record controller start"
        )

    def write_ended(self, receipt: ControllerEndedReceipt) -> None:
        self._write_immutable(
            controller_ended_path(receipt), receipt, "record controller end"
        )

    def reserve_attempt(self, reservation: ControllerAttemptReservation) -> None:
        previous = self.read_attempt(reservation.campaign_id, reservation.attempt - 1)
        if reservation.attempt > 1 and previous is None:
            raise ControllerStatusError(
                "controller attempt reservation has no predecessor"
            )
        self._write_immutable(
            controller_attempt_path(reservation.campaign_id, reservation.attempt),
            reservation,
            "reserve controller attempt",
        )

    def read_attempt(
        self, campaign_id: str, attempt: int
    ) -> ControllerAttemptReservation | None:
        if attempt < 1:
            return None
        head = self._head()
        return self._read_optional(
            controller_attempt_path(campaign_id, attempt),
            head,
            ControllerAttemptReservation,
        )

    def write_recovery(self, decision: ControllerRecoveryDecision) -> None:
        self._write_immutable(
            controller_recovery_path(
                decision.campaign_id, decision.replacement_attempt
            ),
            decision,
            "record controller recovery decision",
        )

    def read_recovery(
        self, campaign_id: str, replacement_attempt: int
    ) -> ControllerRecoveryDecision | None:
        head = self._head()
        return self._read_optional(
            controller_recovery_path(campaign_id, replacement_attempt),
            head,
            ControllerRecoveryDecision,
        )

    def _write_immutable(self, path: str, value: BaseModel, message: str) -> None:
        for _attempt in range(_MAX_COMMIT_ATTEMPTS):
            head = self._head()
            observed = self._read_json_optional(path, head)
            expected = value.model_dump(mode="json")
            if observed is not None:
                if observed != expected:
                    raise ControllerStatusError(
                        f"immutable controller record conflicts: {path}"
                    )
                return
            try:
                self._commit(head, [self._add(path, value)], f"chore: {message}")
                return
            except HfHubHTTPError as error:
                if not _is_parent_conflict(error):
                    raise
        raise ControllerStatusError("controller repository remained contended")

    def _replace_exact(
        self,
        path: str,
        previous: BaseModel,
        replacement: BaseModel,
        message: str,
    ) -> None:
        for _attempt in range(_MAX_COMMIT_ATTEMPTS):
            head = self._head()
            if self._read_json_optional(path, head) != previous.model_dump(mode="json"):
                raise ControllerStatusError("controller record changed concurrently")
            try:
                self._commit(head, [self._add(path, replacement)], message)
                return
            except HfHubHTTPError as error:
                if not _is_parent_conflict(error):
                    raise
        raise ControllerStatusError("controller repository remained contended")

    def _head(self) -> str:
        info = self.api.repo_info(
            self.repository,
            repo_type="dataset",
            revision="main",
            token=self.token,
        )
        revision = getattr(info, "sha", None)
        if not isinstance(revision, str) or not revision:
            raise ControllerStatusError(
                "coordination repository has no commit identity"
            )
        return revision

    def _exists(self, path: str, revision: str) -> bool:
        return bool(
            self.api.get_paths_info(
                self.repository,
                path,
                repo_type="dataset",
                revision=revision,
                token=self.token,
            )
        )

    def _read_json_optional(self, path: str, revision: str) -> dict[str, object] | None:
        if not self._exists(path, revision):
            return None
        local = self.api.hf_hub_download(
            self.repository,
            path,
            repo_type="dataset",
            revision=revision,
            token=self.token,
        )
        try:
            value = json.loads(Path(local).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ControllerStatusError("controller record cannot be read") from error
        if not isinstance(value, dict) or not all(
            isinstance(key, str) for key in value
        ):
            raise ControllerStatusError("controller record must be an object")
        return cast(dict[str, object], value)

    def _read_optional[T: BaseModel](
        self, path: str, revision: str, model: type[T]
    ) -> T | None:
        value = self._read_json_optional(path, revision)
        return None if value is None else model.model_validate(value)

    def _add(self, path: str, value: BaseModel) -> CommitOperationAdd:
        payload = (
            json.dumps(
                value.model_dump(mode="json"),
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        return CommitOperationAdd(path_in_repo=path, path_or_fileobj=payload)

    def _commit(self, head: str, operations: list[object], message: str) -> None:
        self.api.create_commit(
            self.repository,
            operations,
            commit_message=message,
            repo_type="dataset",
            revision="main",
            parent_commit=head,
            token=self.token,
        )


def controller_json_schemas() -> dict[str, dict[str, object]]:
    return {
        "controller_claim": ControllerClaim.model_json_schema(),
        "controller_status": ControllerStatus.model_json_schema(),
        "controller_started": ControllerStartedReceipt.model_json_schema(),
        "controller_ended": ControllerEndedReceipt.model_json_schema(),
        "controller_attempt": ControllerAttemptReservation.model_json_schema(),
        "controller_recovery": ControllerRecoveryDecision.model_json_schema(),
    }


def controller_claim_path(campaign_id: str) -> str:
    _require_safe_id(campaign_id)
    return f"claims/campaign-controllers/{campaign_id}.json"


def controller_status_path(campaign_id: str) -> str:
    _require_safe_id(campaign_id)
    return f"campaigns/{campaign_id}/controller-status.json"


def controller_started_path(receipt: ControllerStartedReceipt) -> str:
    _require_safe_id(receipt.campaign_id)
    _require_safe_id(receipt.job_id)
    return f"campaigns/{receipt.campaign_id}/controllers/{receipt.job_id}/started.json"


def controller_ended_path(receipt: ControllerEndedReceipt) -> str:
    _require_safe_id(receipt.campaign_id)
    _require_safe_id(receipt.job_id)
    return f"campaigns/{receipt.campaign_id}/controllers/{receipt.job_id}/ended.json"


def controller_attempt_path(campaign_id: str, attempt: int) -> str:
    _require_safe_id(campaign_id)
    if attempt < 1:
        raise ValueError("controller attempt must be positive")
    return f"campaigns/{campaign_id}/controller-attempts/{attempt}.json"


def controller_recovery_path(campaign_id: str, replacement_attempt: int) -> str:
    _require_safe_id(campaign_id)
    if replacement_attempt < 2:
        raise ValueError("controller recovery attempt must be at least two")
    return f"campaigns/{campaign_id}/controller-recoveries/{replacement_attempt}.json"


def _require_safe_id(value: str) -> None:
    if _SAFE_ID.fullmatch(value) is None:
        raise ValueError("controller identity must be a safe path component")


def _is_parent_conflict(error: HfHubHTTPError) -> bool:
    response = getattr(error, "response", None)
    return getattr(response, "status_code", None) in {409, 412}

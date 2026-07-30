from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


AdmissionDecision = Literal[
    "admit",
    "wait",
    "finalize",
    "pause-capacity",
    "pause-policy",
]


class RemainingTimeInput(FrozenModel):
    physical_started_monotonic: float = Field(ge=0)
    physical_timeout_seconds: int = Field(ge=1)
    monotonic_now: float = Field(ge=0)
    controller_reserve_seconds: int = Field(ge=1)
    planned_next_wave_seconds: int | None = Field(default=None, ge=1)
    work_remaining: bool
    active_cleanup_required: bool = False
    capacity_assumptions_valid: bool = True
    policy_allows_work: bool = True

    @model_validator(mode="after")
    def monotonic_time_does_not_move_backwards(self) -> RemainingTimeInput:
        if self.monotonic_now < self.physical_started_monotonic:
            raise ValueError("controller monotonic time moved backwards")
        if self.work_remaining != (self.planned_next_wave_seconds is not None):
            raise ValueError("remaining work requires one planned next-wave duration")
        return self


class RemainingTimeAdmission(FrozenModel):
    decision: AdmissionDecision
    elapsed_seconds: int = Field(ge=0)
    available_seconds: int = Field(ge=0)
    required_seconds: int = Field(ge=0)
    reason: str


def decide_remaining_time(value: RemainingTimeInput) -> RemainingTimeAdmission:
    elapsed = max(
        0,
        int(value.monotonic_now - value.physical_started_monotonic),
    )
    available = max(0, value.physical_timeout_seconds - elapsed)
    next_wave = value.planned_next_wave_seconds or 0
    required = value.controller_reserve_seconds + next_wave
    if not value.policy_allows_work:
        return _decision("pause-policy", elapsed, available, required, "policy block")
    if not value.capacity_assumptions_valid:
        return _decision(
            "pause-capacity",
            elapsed,
            available,
            required,
            "observed throughput invalidated the locked duration bound",
        )
    if value.active_cleanup_required:
        return _decision(
            "wait",
            elapsed,
            available,
            value.controller_reserve_seconds,
            "active cleanup must finish before new work",
        )
    if not value.work_remaining:
        return _decision(
            "finalize",
            elapsed,
            available,
            value.controller_reserve_seconds,
            "no billable work remains",
        )
    if available >= required:
        return _decision(
            "admit",
            elapsed,
            available,
            required,
            "next wave fits the physical deadline",
        )
    return _decision(
        "pause-capacity",
        elapsed,
        available,
        required,
        "next wave does not fit the physical deadline with reserve",
    )


def _decision(
    decision: AdmissionDecision,
    elapsed: int,
    available: int,
    required: int,
    reason: str,
) -> RemainingTimeAdmission:
    return RemainingTimeAdmission(
        decision=decision,
        elapsed_seconds=elapsed,
        available_seconds=available,
        required_seconds=required,
        reason=reason,
    )

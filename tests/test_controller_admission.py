import pytest

from harbor_hf.controller_admission import (
    RemainingTimeInput,
    assess_observed_capacity,
    decide_remaining_time,
)
from harbor_hf.models import CampaignControllerSpec


def _input(**updates: object) -> RemainingTimeInput:
    values: dict[str, object] = {
        "physical_started_monotonic": 100.0,
        "physical_timeout_seconds": 1_000,
        "monotonic_now": 200.0,
        "controller_reserve_seconds": 100,
        "planned_next_wave_seconds": 300,
        "work_remaining": True,
    }
    values.update(updates)
    return RemainingTimeInput.model_validate(values)


def _policy() -> CampaignControllerSpec:
    return CampaignControllerSpec(
        planning_trial_seconds=100,
        headroom_factor="1.25",
        wave_reserve_seconds=50,
        controller_reserve_seconds=600,
        heartbeat_seconds=30,
        stale_after_seconds=90,
        max_attempts=3,
    )


def test_remaining_time_admits_only_when_wave_and_reserve_fit() -> None:
    admitted = decide_remaining_time(_input())
    blocked = decide_remaining_time(_input(monotonic_now=701.0))

    assert admitted.model_dump() == {
        "decision": "admit",
        "elapsed_seconds": 100,
        "available_seconds": 900,
        "required_seconds": 400,
        "reason": "next wave fits the physical deadline",
    }
    assert blocked.decision == "pause-capacity"
    assert blocked.available_seconds == 399
    assert blocked.required_seconds == 400


@pytest.mark.parametrize(
    ("updates", "decision"),
    [
        ({"policy_allows_work": False}, "pause-policy"),
        ({"capacity_assumptions_valid": False}, "pause-capacity"),
        ({"active_cleanup_required": True}, "wait"),
        (
            {"work_remaining": False, "planned_next_wave_seconds": None},
            "finalize",
        ),
    ],
)
def test_remaining_time_decision_precedence(
    updates: dict[str, object], decision: str
) -> None:
    assert decide_remaining_time(_input(**updates)).decision == decision


def test_observed_capacity_publishes_raw_effect_and_blocks_invalid_assumptions() -> (
    None
):
    valid = assess_observed_capacity(
        [80.0, 90.0, 100.0, 110.0],
        elapsed_seconds=500,
        effective_concurrency=2,
        remaining_trials=4,
        remaining_waves=1,
        available_seconds=1_000,
        policy=_policy(),
    )
    invalid = assess_observed_capacity(
        [80.0, 90.0, 100.0, 130.0],
        elapsed_seconds=500,
        effective_concurrency=2,
        remaining_trials=4,
        remaining_waves=1,
        available_seconds=1_000,
        policy=_policy(),
    )

    assert valid is not None and valid.assumptions_valid
    assert valid.model_dump() == {
        "completed_trial_count": 4,
        "elapsed_seconds": 500,
        "observed_effective_concurrency": 2,
        "p50_trial_seconds": 90.0,
        "p95_trial_seconds": 110.0,
        "maximum_trial_seconds": 110.0,
        "remaining_trials": 4,
        "projected_remaining_seconds": 925,
        "available_seconds": 1_000,
        "assumptions_valid": True,
    }
    assert invalid is not None and not invalid.assumptions_valid
    assert invalid.p95_trial_seconds == 130.0


def test_observed_capacity_requires_finite_nonnegative_evidence() -> None:
    with pytest.raises(ValueError, match="capacity evidence"):
        assess_observed_capacity(
            [float("nan")],
            elapsed_seconds=0,
            effective_concurrency=1,
            remaining_trials=1,
            remaining_waves=1,
            available_seconds=1_000,
            policy=_policy(),
        )


def test_remaining_time_rejects_inconsistent_or_backward_inputs() -> None:
    with pytest.raises(ValueError, match="remaining work"):
        _input(planned_next_wave_seconds=None)
    with pytest.raises(ValueError, match="moved backwards"):
        _input(monotonic_now=99.0)

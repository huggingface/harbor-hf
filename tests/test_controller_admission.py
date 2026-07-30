import pytest

from harbor_hf.controller_admission import RemainingTimeInput, decide_remaining_time


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


def test_remaining_time_rejects_inconsistent_or_backward_inputs() -> None:
    with pytest.raises(ValueError, match="remaining work"):
        _input(planned_next_wave_seconds=None)
    with pytest.raises(ValueError, match="moved backwards"):
        _input(monotonic_now=99.0)

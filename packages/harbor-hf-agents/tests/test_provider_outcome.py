"""Tests for provider-backed agent terminal outcome classification."""

from __future__ import annotations

import json

import pytest
from harbor.models.trial.result import ExceptionInfo

from harbor_hf_agents.support.provider_outcome import (
    ProviderPolicyError,
    TerminalProviderError,
    TransientProviderError,
    validate_pi_terminal_output,
)


def _event(
    stop_reason: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    error_message: str | None = None,
) -> str:
    message: dict[str, object] = {
        "role": "assistant",
        "stopReason": stop_reason,
        "usage": {"input": input_tokens, "output": output_tokens},
    }
    if error_message is not None:
        message["errorMessage"] = error_message
    return json.dumps({"type": "message_end", "message": message})


def test_accepts_successful_final_response() -> None:
    output = "\n".join(
        [
            _event("toolUse", input_tokens=12, output_tokens=3),
            _event("stop", input_tokens=20, output_tokens=8),
        ]
    )

    validate_pi_terminal_output(output)


def test_classifies_trailing_rate_limit_chain_as_transient() -> None:
    output = "\n".join(
        [
            _event("toolUse", input_tokens=1_000, output_tokens=200),
            _event("error", error_message='429: {"type":"model_rate_limit"}'),
            _event("error", error_message="Provider finish_reason: error"),
        ]
    )

    with pytest.raises(
        TransientProviderError,
        match="provider request ended with a transient failure",
    ) as error:
        validate_pi_terminal_output(output)

    assert "429" not in str(error.value)
    assert "model_rate_limit" not in str(error.value)


def test_policy_failure_takes_precedence_over_rate_limit() -> None:
    output = "\n".join(
        [
            _event("error", error_message="429: rate limit"),
            _event("error", error_message="403: invalid_api_key"),
        ]
    )

    with pytest.raises(ProviderPolicyError, match="locked request policy"):
        validate_pi_terminal_output(output)


def test_unknown_provider_error_is_terminal() -> None:
    with pytest.raises(TerminalProviderError, match="no valid successful"):
        validate_pi_terminal_output(
            _event("error", error_message="Provider finish_reason: error")
        )


def test_harbor_preserves_stable_failure_type_and_safe_message() -> None:
    value = ExceptionInfo.from_exception(TransientProviderError())

    assert value.exception_type == "TransientProviderError"
    assert value.exception_message == "provider request ended with a transient failure"
    assert "429" not in value.exception_message


@pytest.mark.parametrize(
    "output",
    [
        "",
        "not-json\n",
        json.dumps({"type": "message_end", "message": {"role": "user"}}),
        json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "stopReason": "stop",
                    "usage": {"input": "1", "output": 1},
                },
            }
        ),
        _event("toolUse", input_tokens=1, output_tokens=1),
        _event("stop", input_tokens=0, output_tokens=1),
        _event("stop", input_tokens=1, output_tokens=0),
    ],
)
def test_missing_or_malformed_terminal_state_fails_closed(output: str) -> None:
    with pytest.raises(TerminalProviderError, match="no valid successful"):
        validate_pi_terminal_output(output)

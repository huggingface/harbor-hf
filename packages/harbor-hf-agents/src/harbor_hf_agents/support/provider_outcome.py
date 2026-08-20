"""Classify the terminal state of provider-backed agent output."""

from __future__ import annotations

import json
from collections.abc import Mapping

_POLICY_HTTP_STATUSES = (401, 402, 403, 404)
_TRANSIENT_HTTP_STATUSES = (429,)
_POLICY_MARKERS = (
    "authentication_error",
    "authentication failed",
    "invalid api key",
    "invalid_api_key",
    "insufficient_quota",
    "model not found",
    "model_not_found",
    "permission_denied",
    "quota_exceeded",
    "unknown model",
    "unauthorized",
    "forbidden",
)
_TRANSIENT_MARKERS = (
    "model_rate_limit",
    "rate limit",
    "rate_limit",
    "too many requests",
)


class ProviderOutcomeError(RuntimeError):
    """Base class for safe provider terminal failures."""


class TransientProviderError(ProviderOutcomeError):
    """The provider ended the run with an explicitly transient failure."""

    def __init__(self) -> None:
        super().__init__("provider request ended with a transient failure")


class ProviderPolicyError(ProviderOutcomeError):
    """The provider rejected the locked request or account policy."""

    def __init__(self) -> None:
        super().__init__("provider rejected the locked request policy")


class TerminalProviderError(ProviderOutcomeError):
    """The provider run ended without a provable successful final response."""

    def __init__(self) -> None:
        super().__init__("provider run has no valid successful final response")


def _assistant_messages(output: str) -> list[Mapping[str, object]]:
    messages: list[Mapping[str, object]] = []
    for line in output.splitlines():
        try:
            event: object = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(event, dict) or event.get("type") != "message_end":
            continue
        message = event.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            messages.append(
                {key: value for key, value in message.items() if isinstance(key, str)}
            )
    return messages


def _has_valid_usage(message: Mapping[str, object]) -> bool:
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return False
    for key in ("input", "output"):
        value = usage.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return False
    return True


def _error_text(messages: list[Mapping[str, object]]) -> str:
    errors: list[str] = []
    for message in reversed(messages):
        if message.get("stopReason") != "error":
            break
        value = message.get("errorMessage")
        if isinstance(value, str):
            errors.append(value.lower())
    return "\n".join(errors)


def _has_http_status(error_text: str, statuses: tuple[int, ...]) -> bool:
    return any(
        marker in error_text
        for status in statuses
        for marker in (
            f"{status}:",
            f"http {status}",
            f"status {status}",
            f'"status":{status}',
            f'"status": {status}',
        )
    )


def validate_pi_terminal_output(output: str) -> None:
    """Raise a safe typed failure unless Pi reports a successful final response."""
    messages = _assistant_messages(output)
    if not messages:
        raise TerminalProviderError

    final = messages[-1]
    stop_reason = final.get("stopReason")
    if stop_reason == "stop":
        if not _has_valid_usage(final):
            raise TerminalProviderError
        return
    if stop_reason != "error":
        raise TerminalProviderError

    error_text = _error_text(messages)
    if _has_http_status(error_text, _POLICY_HTTP_STATUSES) or any(
        marker in error_text for marker in _POLICY_MARKERS
    ):
        raise ProviderPolicyError
    if _has_http_status(error_text, _TRANSIENT_HTTP_STATUSES) or any(
        marker in error_text for marker in _TRANSIENT_MARKERS
    ):
        raise TransientProviderError
    raise TerminalProviderError

"""Ephemeral Git credentials for private Hugging Face Dataset repositories."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from typing import TextIO

_HOST = "huggingface.co"
_MAX_REQUEST_CHARS = 16_384


class CredentialError(RuntimeError):
    """A credential request cannot be served safely."""


def _read_request(stream: TextIO) -> dict[str, str]:
    request = stream.read(_MAX_REQUEST_CHARS + 1)
    if len(request) > _MAX_REQUEST_CHARS:
        raise CredentialError("Git credential request exceeds its size limit")

    fields: dict[str, str] = {}
    for line in request.splitlines():
        if not line:
            break
        key, separator, value = line.partition("=")
        if not separator or not key:
            raise CredentialError("Git credential request is malformed")
        if key in {"protocol", "host"} and key in fields:
            raise CredentialError("Git credential request is malformed")
        fields[key] = value
    return fields


def credential_response(
    operation: str,
    fields: Mapping[str, str],
    token: str | None,
) -> dict[str, str]:
    """Return one host-restricted response without storing credential material."""
    if operation in {"store", "erase"}:
        return {}
    if operation != "get":
        raise CredentialError("Git credential operation is not supported")
    if fields.get("protocol") != "https" or fields.get("host") != _HOST:
        return {}
    if not token:
        raise CredentialError(
            "HF_TOKEN is required for private Hugging Face Dataset access"
        )
    if any(character in token for character in "\r\n\0"):
        raise CredentialError("HF_TOKEN is not valid for Git credential delivery")
    return {"username": "hf_user", "password": token}


def main() -> None:
    """Serve one Git credential-helper request."""
    try:
        operation = sys.argv[1] if len(sys.argv) == 2 else ""
        response = credential_response(
            operation,
            _read_request(sys.stdin),
            os.environ.get("HF_TOKEN"),
        )
    except CredentialError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from None

    for key, value in response.items():
        print(f"{key}={value}")
    if response:
        print()


if __name__ == "__main__":
    main()

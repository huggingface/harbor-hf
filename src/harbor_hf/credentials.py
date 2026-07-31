from __future__ import annotations

import os
from collections.abc import Mapping
from typing import TypedDict, cast

from huggingface_hub import HfApi
from huggingface_hub.utils import get_stored_tokens

from harbor_hf.config import (
    HarborHFConfig,
    empty_harbor_hf_config,
    harbor_hf_config_path,
    load_harbor_hf_config,
    save_harbor_hf_config,
)

_JOB_TOKEN_ENVIRONMENT_VARIABLE = "HARBOR_HF_JOB_TOKEN"


class VerifiedTokenIdentity(TypedDict):
    owner: str
    role: str


def stored_hf_tokens() -> dict[str, str]:
    """Return named Hugging Face tokens from the official local credential store."""

    return get_stored_tokens()


def select_job_hf_token(
    token_name: str,
    *,
    tokens: Mapping[str, str] | None = None,
) -> tuple[HarborHFConfig, VerifiedTokenIdentity]:
    available = stored_hf_tokens() if tokens is None else tokens
    token = available.get(token_name)
    if token is None:
        raise ValueError(
            f"Hugging Face token {token_name!r} is not saved; run `hf auth list`"
        )
    identity = verify_job_hf_token(token)
    config = HarborHFConfig(
        schema_version="harbor-hf/config/v1", hf_job_token_name=token_name
    )
    save_harbor_hf_config(config)
    return config, identity


def verify_job_hf_token(token: str) -> VerifiedTokenIdentity:
    """Verify one token without returning or persisting its value."""

    raw = HfApi(token=token).whoami()
    owner = raw.get("name")
    auth = raw.get("auth")
    access = auth.get("accessToken") if isinstance(auth, dict) else None
    role = access.get("role") if isinstance(access, dict) else None
    if not isinstance(owner, str) or not owner:
        raise ValueError("Hugging Face token verification returned no owner")
    if role != "fineGrained":
        raise ValueError("Harbor HF remote Jobs require a fine-grained HF token")
    return VerifiedTokenIdentity(owner=owner, role=cast(str, role))


def configured_job_hf_token(
    *,
    environ: Mapping[str, str] | None = None,
    tokens: Mapping[str, str] | None = None,
) -> str | None:
    values = os.environ if environ is None else environ
    explicit = values.get(_JOB_TOKEN_ENVIRONMENT_VARIABLE, "")
    if explicit:
        return explicit
    config = load_harbor_hf_config()
    token_name = config.hf_job_token_name
    if token_name is None:
        return None
    available = stored_hf_tokens() if tokens is None else tokens
    token = available.get(token_name)
    if token is None:
        raise ValueError(
            f"configured Hugging Face Job token {token_name!r} is no longer saved; "
            "run `harbor-hf auth use-job-token TOKEN_NAME`"
        )
    return token


def clear_job_hf_token() -> HarborHFConfig:
    config = empty_harbor_hf_config()
    save_harbor_hf_config(config)
    return config


def job_hf_token_status(
    *, tokens: Mapping[str, str] | None = None
) -> dict[str, object]:
    config = load_harbor_hf_config()
    available = stored_hf_tokens() if tokens is None else tokens
    selected = config.hf_job_token_name
    return {
        "config_path": str(harbor_hf_config_path()),
        "selected_token_name": selected,
        "selected_token_available": (
            selected in available if selected is not None else False
        ),
        "environment_override": bool(os.environ.get(_JOB_TOKEN_ENVIRONMENT_VARIABLE)),
    }

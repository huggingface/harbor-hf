from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import TypedDict, cast

from huggingface_hub import HfApi

from harbor_hf.config import (
    HarborHFConfig,
    empty_harbor_hf_config,
    harbor_hf_config_path,
    load_harbor_hf_config,
    save_harbor_hf_config,
)
from harbor_hf.token_store import (
    harbor_hf_token_store_path,
    load_harbor_hf_tokens,
    remove_harbor_hf_token,
    store_harbor_hf_token,
)

_JOB_TOKEN_ENVIRONMENT_VARIABLE = "HARBOR_HF_JOB_TOKEN"


class VerifiedTokenIdentity(TypedDict):
    owner: str
    role: str


def stored_job_hf_tokens() -> dict[str, str]:
    """Return named tokens from Harbor HF's private local token store."""

    return load_harbor_hf_tokens()


def add_job_hf_token(
    token_name: str,
    token: str,
    *,
    replace: bool = False,
) -> tuple[HarborHFConfig, VerifiedTokenIdentity, Path]:
    available = stored_job_hf_tokens()
    if token_name in available and not replace:
        raise ValueError(
            f"Harbor HF token {token_name!r} is already saved; "
            "pass --force to replace it"
        )
    identity = verify_job_hf_token(token)
    store_path = store_harbor_hf_token(token_name, token, replace=replace)
    config = _select_token_name(token_name)
    return config, identity, store_path


def select_job_hf_token(
    token_name: str,
    *,
    tokens: Mapping[str, str] | None = None,
) -> tuple[HarborHFConfig, VerifiedTokenIdentity]:
    available = stored_job_hf_tokens() if tokens is None else tokens
    token = available.get(token_name)
    if token is None:
        raise ValueError(
            f"Harbor HF token {token_name!r} is not saved; run "
            "`harbor-hf auth add-job-token TOKEN_NAME`"
        )
    identity = verify_job_hf_token(token)
    return _select_token_name(token_name), identity


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
    available = stored_job_hf_tokens() if tokens is None else tokens
    token = available.get(token_name)
    if token is None:
        raise ValueError(
            f"configured Harbor HF Job token {token_name!r} is no longer saved; "
            "run `harbor-hf auth add-job-token TOKEN_NAME` or select another token"
        )
    return token


def clear_job_hf_token() -> HarborHFConfig:
    config = empty_harbor_hf_config()
    save_harbor_hf_config(config)
    return config


def remove_job_hf_token(token_name: str) -> tuple[Path, bool]:
    if token_name not in stored_job_hf_tokens():
        raise ValueError(f"Harbor HF token {token_name!r} is not saved")
    config = load_harbor_hf_config()
    cleared_selection = config.hf_job_token_name == token_name
    if cleared_selection:
        clear_job_hf_token()
    store_path = remove_harbor_hf_token(token_name)
    return store_path, cleared_selection


def job_hf_token_status(
    *, tokens: Mapping[str, str] | None = None
) -> dict[str, object]:
    config = load_harbor_hf_config()
    available = stored_job_hf_tokens() if tokens is None else tokens
    selected = config.hf_job_token_name
    return {
        "config_path": str(harbor_hf_config_path()),
        "token_store_path": str(harbor_hf_token_store_path()),
        "selected_token_name": selected,
        "selected_token_available": (
            selected in available if selected is not None else False
        ),
        "environment_override": bool(os.environ.get(_JOB_TOKEN_ENVIRONMENT_VARIABLE)),
    }


def _select_token_name(token_name: str) -> HarborHFConfig:
    config = HarborHFConfig(
        schema_version="harbor-hf/config/v1", hf_job_token_name=token_name
    )
    save_harbor_hf_config(config)
    return config

from __future__ import annotations

import json
import os
import stat
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

_CONFIG_SCHEMA_VERSION = "harbor-hf/config/v1"
_CONFIG_ENVIRONMENT_VARIABLE = "HARBOR_HF_CONFIG"
_MAX_CONFIG_BYTES = 16 * 1024


class HarborHFConfig(BaseModel):
    """Local, secret-free Harbor HF operator configuration."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["harbor-hf/config/v1"]
    hf_job_token_name: str | None = Field(default=None, max_length=256)

    @field_validator("hf_job_token_name")
    @classmethod
    def token_name_is_safe(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value != value.strip() or not value:
            raise ValueError(
                "Job HF token name must be nonempty without outer whitespace"
            )
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Job HF token name cannot contain control characters")
        return value


def empty_harbor_hf_config() -> HarborHFConfig:
    return HarborHFConfig(schema_version=_CONFIG_SCHEMA_VERSION)


def harbor_hf_config_json_schema() -> dict[str, object]:
    return HarborHFConfig.model_json_schema()


def harbor_hf_config_path(
    environ: Mapping[str, str] | None = None,
) -> Path:
    values = os.environ if environ is None else environ
    explicit = values.get(_CONFIG_ENVIRONMENT_VARIABLE)
    if explicit:
        return Path(explicit).expanduser()
    config_home = values.get("XDG_CONFIG_HOME")
    root = Path(config_home).expanduser() if config_home else Path.home() / ".config"
    return root / "harbor-hf" / "config.json"


def load_harbor_hf_config(path: Path | None = None) -> HarborHFConfig:
    source = harbor_hf_config_path() if path is None else path
    if not source.exists() and not source.is_symlink():
        return empty_harbor_hf_config()
    _validate_config_file(source)
    data = source.read_bytes()
    if len(data) > _MAX_CONFIG_BYTES:
        raise ValueError("Harbor HF config exceeds the 16 KiB limit")
    try:
        return HarborHFConfig.model_validate_json(data)
    except ValueError as error:
        raise ValueError(f"invalid Harbor HF config at {source}: {error}") from error


def save_harbor_hf_config(
    config: HarborHFConfig,
    path: Path | None = None,
) -> Path:
    destination = harbor_hf_config_path() if path is None else path
    parent = destination.parent
    if parent.is_symlink():
        raise ValueError(f"Harbor HF config directory cannot be a symlink: {parent}")
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        _validate_config_file(destination)
    payload = (
        json.dumps(config.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=".config-", dir=parent)
        temporary = Path(name)
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        temporary = None
        os.chmod(destination, 0o600)
        _sync_directory(parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def _validate_config_file(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"Harbor HF config cannot be a symlink: {path}")
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"Harbor HF config must be a regular file: {path}")
    if metadata.st_mode & 0o077:
        raise ValueError(f"Harbor HF config permissions must be 0600: {path}")
    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid != getuid():
        raise ValueError(f"Harbor HF config must be owned by the current user: {path}")


def _sync_directory(path: Path) -> None:
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if directory_flag is None:
        return
    descriptor = os.open(path, os.O_RDONLY | directory_flag)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

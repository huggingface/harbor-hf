"""Load strict global configuration for the Harbor-HF command-line client."""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import yaml

_CONFIG_ENV = "HARBOR_HF_CONFIG_PATH"
_MAX_COST_CEILING_USD_PER_TRIAL = 10_000.0


class ClientConfigError(ValueError):
    """The global client configuration is invalid."""


@dataclass(frozen=True)
class SpendLimits:
    """Optional local bounds for an explicit per-trial cost ceiling."""

    minimum_cost_ceiling_usd_per_trial: float | None = None
    maximum_cost_ceiling_usd_per_trial: float | None = None


@dataclass(frozen=True)
class ClientConfig:
    """Validated global client configuration."""

    path: Path
    exists: bool
    spend: SpendLimits = SpendLimits()


def client_config_path(environment: Mapping[str, str] | None = None) -> Path:
    """Return the configured or platform-standard global client config path."""
    values = os.environ if environment is None else environment
    explicit = values.get(_CONFIG_ENV, "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    root = values.get("XDG_CONFIG_HOME", "").strip()
    base = Path(root).expanduser() if root else Path.home() / ".config"
    return (base / "harbor-hf" / "config.yaml").resolve()


def _mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ClientConfigError(f"{label} must be an object")
    return cast(dict[str, object], value)


def _reject_unknown(value: Mapping[str, object], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ClientConfigError(f"{label} contains unknown field: {unknown[0]}")


def _optional_ceiling(value: object, label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ClientConfigError(f"{label} must be a number")
    result = float(value)
    if (
        not math.isfinite(result)
        or result <= 0
        or result > _MAX_COST_CEILING_USD_PER_TRIAL
    ):
        raise ClientConfigError(f"{label} must be greater than 0 and at most 10000")
    return result


def _spend_limits(value: object) -> SpendLimits:
    if value is None:
        return SpendLimits()
    spend = _mapping(value, "spend")
    allowed = {
        "minimum_cost_ceiling_usd_per_trial",
        "maximum_cost_ceiling_usd_per_trial",
    }
    _reject_unknown(spend, allowed, "spend")
    minimum = _optional_ceiling(
        spend.get("minimum_cost_ceiling_usd_per_trial"),
        "spend.minimum_cost_ceiling_usd_per_trial",
    )
    maximum = _optional_ceiling(
        spend.get("maximum_cost_ceiling_usd_per_trial"),
        "spend.maximum_cost_ceiling_usd_per_trial",
    )
    if minimum is not None and maximum is not None and minimum > maximum:
        raise ClientConfigError("the minimum cost ceiling cannot exceed the maximum")
    return SpendLimits(minimum, maximum)


def load_client_config(
    environment: Mapping[str, str] | None = None,
) -> ClientConfig:
    """Load the global config, with no limits when the file does not exist."""
    path = client_config_path(environment)
    if not path.exists():
        return ClientConfig(path=path, exists=False)
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ClientConfigError(
            f"cannot read Harbor-HF config: {type(error).__name__}"
        ) from error
    root = _mapping(raw, "config")
    _reject_unknown(root, {"schema_version", "spend"}, "config")
    if root.get("schema_version") != "v1":
        raise ClientConfigError("config.schema_version must be v1")
    return ClientConfig(path=path, exists=True, spend=_spend_limits(root.get("spend")))


def validate_cost_ceiling(value: float, config: ClientConfig) -> None:
    """Reject an explicit per-trial ceiling outside the local policy."""
    minimum = config.spend.minimum_cost_ceiling_usd_per_trial
    maximum = config.spend.maximum_cost_ceiling_usd_per_trial
    if minimum is not None and value < minimum:
        message = (
            f"cost ceiling must be at least ${minimum:g} per trial "
            "under the global config"
        )
        raise ClientConfigError(message)
    if maximum is not None and value > maximum:
        message = (
            f"cost ceiling must be at most ${maximum:g} per trial "
            "under the global config"
        )
        raise ClientConfigError(message)

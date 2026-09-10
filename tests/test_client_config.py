from __future__ import annotations

from pathlib import Path

import pytest

from harbor_hf.client_config import (
    ClientConfigError,
    client_config_path,
    load_client_config,
    validate_cost_ceiling,
)


def write_config(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def test_missing_global_config_leaves_spend_limits_unspecified(tmp_path: Path) -> None:
    path = tmp_path / "missing.yaml"
    config = load_client_config({"HARBOR_HF_CONFIG_PATH": str(path)})

    assert config.path == path
    assert not config.exists
    assert config.spend.minimum_cost_ceiling_usd_per_trial is None
    assert config.spend.maximum_cost_ceiling_usd_per_trial is None
    validate_cost_ceiling(0.25, config)


def test_uses_xdg_global_config_path(tmp_path: Path) -> None:
    assert client_config_path({"XDG_CONFIG_HOME": str(tmp_path)}) == (
        tmp_path / "harbor-hf" / "config.yaml"
    )


def test_loads_and_enforces_global_spend_limits(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    write_config(
        path,
        """schema_version: v1
spend:
  minimum_cost_ceiling_usd_per_trial: 100
  maximum_cost_ceiling_usd_per_trial: 1000
""",
    )
    config = load_client_config({"HARBOR_HF_CONFIG_PATH": str(path)})

    assert config.exists
    assert config.spend.minimum_cost_ceiling_usd_per_trial == 100
    assert config.spend.maximum_cost_ceiling_usd_per_trial == 1000
    validate_cost_ceiling(100, config)
    validate_cost_ceiling(1000, config)
    with pytest.raises(ClientConfigError, match=r"at least \$100 per trial"):
        validate_cost_ceiling(99, config)
    with pytest.raises(ClientConfigError, match=r"at most \$1000 per trial"):
        validate_cost_ceiling(1001, config)


@pytest.mark.parametrize(
    "body, message",
    [
        ("schema_version: v2\n", "schema_version must be v1"),
        ("schema_version: v1\nother: true\n", "unknown field: other"),
        (
            """schema_version: v1
spend:
  minimum_cost_ceiling_usd_per_trial: 10
  maximum_cost_ceiling_usd_per_trial: 5
""",
            "minimum cost ceiling cannot exceed the maximum",
        ),
        (
            """schema_version: v1
spend:
  minimum_cost_ceiling_usd_per_trial: false
""",
            "must be a number",
        ),
    ],
)
def test_rejects_invalid_global_config(tmp_path: Path, body: str, message: str) -> None:
    path = tmp_path / "config.yaml"
    write_config(path, body)

    with pytest.raises(ClientConfigError, match=message):
        load_client_config({"HARBOR_HF_CONFIG_PATH": str(path)})

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from harbor_hf.cli import app
from harbor_hf.config import load_harbor_hf_config

runner = CliRunner()


def test_auth_schema_writes_checked_in_contract(tmp_path: Path) -> None:
    output = tmp_path / "config.schema.json"

    result = runner.invoke(app, ["auth", "schema", "--output", str(output)])

    assert result.exit_code == 0
    checked_in = (
        Path(__file__).parent.parent / "schemas/harbor-hf-config-v1.schema.json"
    )
    assert json.loads(output.read_text(encoding="utf-8")) == json.loads(
        checked_in.read_text(encoding="utf-8")
    )


def test_auth_tokens_lists_names_without_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "hf_secret-must-not-appear"
    monkeypatch.setattr(
        "harbor_hf.credentials.stored_hf_tokens",
        lambda: {"second": secret, "first": "another-secret"},
    )

    result = runner.invoke(app, ["auth", "tokens"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["tokens"] == [
        {"name": "first", "selected": False},
        {"name": "second", "selected": False},
    ]
    assert secret not in result.stdout
    assert "another-secret" not in result.stdout


def test_auth_use_job_token_confirms_exact_destination_and_saves_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(config_path))
    secret = "hf_secret-must-not-appear"
    monkeypatch.setattr(
        "harbor_hf.credentials.stored_hf_tokens", lambda: {"campaign": secret}
    )
    monkeypatch.setattr(
        "harbor_hf.credentials.verify_job_hf_token",
        lambda token: (
            {"owner": "osolmaz", "role": "fineGrained"}
            if token == secret
            else pytest.fail("wrong token")
        ),
    )

    result = runner.invoke(app, ["auth", "use-job-token", "campaign"], input="y\n")

    assert result.exit_code == 0
    assert "secret HF_TOKEN on future Harbor HF Jobs" in result.stdout
    payload = json.loads(result.stdout[result.stdout.index("{") :])
    assert payload == {
        "config_path": str(config_path),
        "environment_override": True,
        "owner": "osolmaz",
        "remote_job_secret_name": "HF_TOKEN",
        "role": "fineGrained",
        "selected_token_name": "campaign",
        "token_value_stored_in_config": False,
    }
    assert load_harbor_hf_config(config_path).hf_job_token_name == "campaign"
    assert secret not in result.stdout
    assert secret not in config_path.read_text(encoding="utf-8")


def test_auth_use_job_token_requires_confirmation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(config_path))
    monkeypatch.setattr(
        "harbor_hf.credentials.stored_hf_tokens", lambda: {"campaign": "secret"}
    )

    result = runner.invoke(app, ["auth", "use-job-token", "campaign"], input="n\n")

    assert result.exit_code == 1
    assert not config_path.exists()


def test_auth_use_job_token_yes_is_noninteractive_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(config_path))
    monkeypatch.setattr(
        "harbor_hf.credentials.stored_hf_tokens", lambda: {"campaign": "secret"}
    )
    monkeypatch.setattr(
        "harbor_hf.credentials.verify_job_hf_token",
        lambda _token: {"owner": "osolmaz", "role": "fineGrained"},
    )

    result = runner.invoke(app, ["auth", "use-job-token", "campaign", "--yes"])

    assert result.exit_code == 0
    assert load_harbor_hf_config(config_path).hf_job_token_name == "campaign"


def test_auth_use_job_token_rejects_unknown_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harbor_hf.credentials.stored_hf_tokens", dict)

    result = runner.invoke(app, ["auth", "use-job-token", "missing", "--yes"])

    assert result.exit_code == 1
    assert "is not saved" in result.stderr


def test_auth_status_and_clear(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(config_path))
    monkeypatch.setattr(
        "harbor_hf.credentials.stored_hf_tokens", lambda: {"campaign": "secret"}
    )
    monkeypatch.setattr(
        "harbor_hf.credentials.verify_job_hf_token",
        lambda _token: {"owner": "osolmaz", "role": "fineGrained"},
    )
    selected = runner.invoke(app, ["auth", "use-job-token", "campaign", "--yes"])
    assert selected.exit_code == 0

    status = runner.invoke(app, ["auth", "status"])
    assert status.exit_code == 0
    assert json.loads(status.stdout)["selected_token_name"] == "campaign"

    cleared = runner.invoke(app, ["auth", "clear-job-token"])
    assert cleared.exit_code == 0
    payload = json.loads(cleared.stdout)
    assert payload["selected_token_name"] is None
    assert payload["selected_token_available"] is False
    assert "campaign" in {
        token["name"]
        for token in json.loads(runner.invoke(app, ["auth", "tokens"]).stdout)["tokens"]
    }

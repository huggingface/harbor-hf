from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from harbor_hf.cli import app
from harbor_hf.config import load_harbor_hf_config
from harbor_hf.token_store import load_harbor_hf_tokens, save_harbor_hf_tokens

runner = CliRunner()


def _set_auth_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path]:
    config_path = tmp_path / "private" / "config.json"
    token_store_path = tmp_path / "private" / "stored_tokens"
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(config_path))
    monkeypatch.setenv("HARBOR_HF_TOKEN_STORE", str(token_store_path))
    return config_path, token_store_path


def _verified_identity(_token: str) -> dict[str, str]:
    return {"owner": "osolmaz", "role": "fineGrained"}


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


def test_auth_tokens_lists_harbor_names_without_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    secret = "hf_secret-must-not-appear"
    save_harbor_hf_tokens({"second": secret, "first": "another-secret"}, store_path)

    result = runner.invoke(app, ["auth", "tokens"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload == {
        "config_path": str(config_path),
        "token_store_path": str(store_path),
        "tokens": [
            {"name": "first", "selected": False},
            {"name": "second", "selected": False},
        ],
    }
    assert secret not in result.stdout
    assert "another-secret" not in result.stdout


def test_auth_add_job_token_uses_hidden_input_and_selects_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    secret = "hf_secret-must-not-appear"
    monkeypatch.setattr("harbor_hf.credentials.verify_job_hf_token", _verified_identity)

    result = runner.invoke(
        app,
        ["auth", "add-job-token", "campaign"],
        input=f"y\n{secret}\n",
    )

    assert result.exit_code == 0
    assert "Harbor HF's local token store" in result.stdout
    assert "secret HF_TOKEN on future Harbor HF Jobs" in result.stdout
    assert secret not in result.stdout
    payload = json.loads(result.stdout[result.stdout.index("{") :])
    assert payload == {
        "config_path": str(config_path),
        "environment_override": True,
        "owner": "osolmaz",
        "remote_job_secret_name": "HF_TOKEN",
        "role": "fineGrained",
        "selected_token_name": "campaign",
        "token_store_path": str(store_path),
        "token_value_stored_in_config": False,
        "token_value_stored_in_harbor_token_store": True,
    }
    assert load_harbor_hf_config(config_path).hf_job_token_name == "campaign"
    assert load_harbor_hf_tokens(store_path) == {"campaign": secret}
    assert secret not in config_path.read_text(encoding="utf-8")


def test_auth_add_job_token_requires_approval_before_prompting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)

    result = runner.invoke(app, ["auth", "add-job-token", "campaign"], input="n\n")

    assert result.exit_code == 1
    assert "Hugging Face token" not in result.stdout
    assert not config_path.exists()
    assert not store_path.exists()


def test_auth_add_job_token_yes_is_noninteractive_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    monkeypatch.setattr("harbor_hf.credentials.verify_job_hf_token", _verified_identity)

    result = runner.invoke(
        app,
        ["auth", "add-job-token", "campaign", "--yes"],
        input="hf_secret\n",
    )

    assert result.exit_code == 0
    assert load_harbor_hf_config(config_path).hf_job_token_name == "campaign"
    assert load_harbor_hf_tokens(store_path) == {"campaign": "hf_secret"}


def test_auth_add_job_token_requires_force_to_replace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    save_harbor_hf_tokens({"campaign": "hf_old"}, store_path)

    rejected = runner.invoke(
        app, ["auth", "add-job-token", "campaign", "--yes"], input="hf_new\n"
    )

    assert rejected.exit_code == 1
    assert "--force" in rejected.stderr
    assert "Hugging Face token" not in rejected.stdout
    assert load_harbor_hf_tokens(store_path) == {"campaign": "hf_old"}

    monkeypatch.setattr("harbor_hf.credentials.verify_job_hf_token", _verified_identity)
    replaced = runner.invoke(
        app,
        ["auth", "add-job-token", "campaign", "--force", "--yes"],
        input="hf_new\n",
    )
    assert replaced.exit_code == 0
    assert load_harbor_hf_tokens(store_path) == {"campaign": "hf_new"}


def test_auth_use_job_token_confirms_exact_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    secret = "hf_secret-must-not-appear"
    save_harbor_hf_tokens({"campaign": secret}, store_path)
    monkeypatch.setattr("harbor_hf.credentials.verify_job_hf_token", _verified_identity)

    result = runner.invoke(app, ["auth", "use-job-token", "campaign"], input="y\n")

    assert result.exit_code == 0
    assert "secret HF_TOKEN on future Harbor HF Jobs" in result.stdout
    assert secret not in result.stdout
    payload = json.loads(result.stdout[result.stdout.index("{") :])
    assert payload["token_store_path"] == str(store_path)
    assert payload["token_value_stored_in_harbor_token_store"] is True
    assert load_harbor_hf_config(config_path).hf_job_token_name == "campaign"


def test_auth_use_job_token_rejects_unknown_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_auth_paths(tmp_path, monkeypatch)

    result = runner.invoke(app, ["auth", "use-job-token", "missing", "--yes"])

    assert result.exit_code == 1
    assert "add-job-token" in result.stderr


def test_auth_status_and_clear_preserve_saved_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    save_harbor_hf_tokens({"campaign": "secret"}, store_path)
    monkeypatch.setattr("harbor_hf.credentials.verify_job_hf_token", _verified_identity)
    assert (
        runner.invoke(app, ["auth", "use-job-token", "campaign", "--yes"]).exit_code
        == 0
    )

    status = runner.invoke(app, ["auth", "status"])
    assert status.exit_code == 0
    assert json.loads(status.stdout)["selected_token_name"] == "campaign"

    cleared = runner.invoke(app, ["auth", "clear-job-token"])
    assert cleared.exit_code == 0
    payload = json.loads(cleared.stdout)
    assert payload["selected_token_name"] is None
    assert payload["selected_token_available"] is False
    assert load_harbor_hf_tokens(store_path) == {"campaign": "secret"}


def test_auth_remove_selected_token_also_clears_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    save_harbor_hf_tokens({"campaign": "secret", "other": "kept"}, store_path)
    monkeypatch.setattr("harbor_hf.credentials.verify_job_hf_token", _verified_identity)
    assert (
        runner.invoke(app, ["auth", "use-job-token", "campaign", "--yes"]).exit_code
        == 0
    )

    result = runner.invoke(app, ["auth", "remove-job-token", "campaign"], input="y\n")

    assert result.exit_code == 0
    payload = json.loads(result.stdout[result.stdout.index("{") :])
    assert payload["cleared_selection"] is True
    assert payload["removed_token_name"] == "campaign"
    assert load_harbor_hf_config(config_path).hf_job_token_name is None
    assert load_harbor_hf_tokens(store_path) == {"other": "kept"}


def test_auth_remove_job_token_requires_confirmation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _config_path, store_path = _set_auth_paths(tmp_path, monkeypatch)
    save_harbor_hf_tokens({"campaign": "secret"}, store_path)

    result = runner.invoke(app, ["auth", "remove-job-token", "campaign"], input="n\n")

    assert result.exit_code == 1
    assert load_harbor_hf_tokens(store_path) == {"campaign": "secret"}

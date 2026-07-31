from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest
from pydantic import ValidationError

from harbor_hf.config import (
    HarborHFConfig,
    harbor_hf_config_json_schema,
    harbor_hf_config_path,
    load_harbor_hf_config,
    save_harbor_hf_config,
)
from harbor_hf.credentials import (
    VerifiedTokenIdentity,
    clear_job_hf_token,
    configured_job_hf_token,
    job_hf_token_status,
    select_job_hf_token,
    verify_job_hf_token,
)
from harbor_hf.token_store import harbor_hf_auth_lock, save_harbor_hf_tokens


def test_config_path_prefers_explicit_path() -> None:
    assert (
        harbor_hf_config_path(
            {
                "HARBOR_HF_CONFIG": "~/custom.json",
                "XDG_CONFIG_HOME": "/ignored",
            }
        )
        == Path.home() / "custom.json"
    )


def test_config_path_uses_xdg_config_home() -> None:
    assert harbor_hf_config_path({"XDG_CONFIG_HOME": "/config"}) == Path(
        "/config/harbor-hf/config.json"
    )


def test_config_round_trip_stores_only_token_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "nested" / "config.json"
    token_value = "hf_secret-value-that-must-not-be-written"
    config = HarborHFConfig(
        schema_version="harbor-hf/config/v1",
        hf_job_token_name="campaign-job-token",
    )

    saved = save_harbor_hf_config(config, path)

    assert saved == path
    assert load_harbor_hf_config(path) == config
    assert path.stat().st_mode & 0o777 == 0o600
    assert token_value not in path.read_text(encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "hf_job_token_name": "campaign-job-token",
        "schema_version": "harbor-hf/config/v1",
    }
    token_store_path = path.parent / "stored_tokens"
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(path))
    monkeypatch.setenv("HARBOR_HF_TOKEN_STORE", str(token_store_path))
    save_harbor_hf_tokens({"campaign-job-token": token_value}, token_store_path)
    assert job_hf_token_status() == {
        "config_path": str(path),
        "token_store_path": str(path.parent / "stored_tokens"),
        "selected_token_name": "campaign-job-token",
        "selected_token_available": True,
        "environment_override": True,
    }


def test_config_schema_matches_checked_in_contract() -> None:
    path = Path(__file__).parent.parent / "schemas/harbor-hf-config-v1.schema.json"
    assert json.loads(path.read_text(encoding="utf-8")) == (
        harbor_hf_config_json_schema()
    )


def test_missing_config_loads_empty_config(tmp_path: Path) -> None:
    assert load_harbor_hf_config(tmp_path / "missing.json") == HarborHFConfig(
        schema_version="harbor-hf/config/v1"
    )


@pytest.mark.parametrize("name", ["", " outer", "outer ", "line\nbreak"])
def test_config_rejects_unsafe_token_names(name: str) -> None:
    with pytest.raises(ValidationError, match="token name"):
        HarborHFConfig(schema_version="harbor-hf/config/v1", hf_job_token_name=name)


def test_config_rejects_missing_schema_version(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text('{"hf_job_token_name":"named"}\n', encoding="utf-8")
    path.chmod(0o600)

    with pytest.raises(ValueError, match="invalid Harbor HF config"):
        load_harbor_hf_config(path)


def test_config_rejects_unknown_fields(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text(
        '{"schema_version":"harbor-hf/config/v1","token":"secret"}\n',
        encoding="utf-8",
    )
    path.chmod(0o600)

    with pytest.raises(ValueError, match="invalid Harbor HF config"):
        load_harbor_hf_config(path)


def test_config_rejects_oversized_file(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_bytes(b" " * (16 * 1024 + 1))
    path.chmod(0o600)

    with pytest.raises(ValueError, match="exceeds the 16 KiB limit"):
        load_harbor_hf_config(path)


def test_config_rejects_insecure_permissions(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text(
        '{"schema_version":"harbor-hf/config/v1","hf_job_token_name":null}\n',
        encoding="utf-8",
    )
    path.chmod(0o644)

    with pytest.raises(ValueError, match="permissions must be 0600"):
        load_harbor_hf_config(path)


def test_config_rejects_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text(
        '{"schema_version":"harbor-hf/config/v1","hf_job_token_name":null}\n',
        encoding="utf-8",
    )
    target.chmod(0o600)
    link = tmp_path / "config.json"
    link.symlink_to(target)

    with pytest.raises(ValueError, match="cannot be a symlink"):
        load_harbor_hf_config(link)


def test_save_rejects_symlinked_config_directory(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "linked"
    link.symlink_to(real, target_is_directory=True)

    with pytest.raises(ValueError, match="directory cannot be a symlink"):
        save_harbor_hf_config(
            HarborHFConfig(schema_version="harbor-hf/config/v1"),
            link / "config.json",
        )


def test_environment_job_token_takes_precedence_over_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "config.json"
    save_harbor_hf_config(
        HarborHFConfig(
            schema_version="harbor-hf/config/v1", hf_job_token_name="saved-token"
        ),
        path,
    )
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(path))

    assert (
        configured_job_hf_token(
            environ={"HARBOR_HF_JOB_TOKEN": "explicit-token"},
        )
        == "explicit-token"
    )


def test_configured_job_token_reads_selected_named_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "config.json"
    save_harbor_hf_config(
        HarborHFConfig(
            schema_version="harbor-hf/config/v1", hf_job_token_name="saved-token"
        ),
        path,
    )
    token_store_path = tmp_path / "stored_tokens"
    save_harbor_hf_tokens({"saved-token": "stored-token"}, token_store_path)
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(path))
    monkeypatch.setenv("HARBOR_HF_TOKEN_STORE", str(token_store_path))

    assert configured_job_hf_token(environ={}) == "stored-token"


def test_configured_job_token_fails_when_selection_is_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "config.json"
    save_harbor_hf_config(
        HarborHFConfig(
            schema_version="harbor-hf/config/v1", hf_job_token_name="missing-token"
        ),
        path,
    )
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(path))
    monkeypatch.setenv("HARBOR_HF_TOKEN_STORE", str(tmp_path / "stored_tokens"))

    with pytest.raises(ValueError, match="is no longer saved"):
        configured_job_hf_token(environ={})


def test_select_and_clear_job_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "config.json"
    token_store_path = tmp_path / "stored_tokens"
    save_harbor_hf_tokens({"job-token": "secret-value"}, token_store_path)
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(path))
    monkeypatch.setenv("HARBOR_HF_TOKEN_STORE", str(token_store_path))
    monkeypatch.setattr(
        "harbor_hf.credentials.verify_job_hf_token",
        lambda _token: {"owner": "owner", "role": "fineGrained"},
    )

    config, identity = select_job_hf_token("job-token")

    assert config.hf_job_token_name == "job-token"
    assert identity == {"owner": "owner", "role": "fineGrained"}
    assert "secret-value" not in path.read_text(encoding="utf-8")
    clear_job_hf_token()
    assert load_harbor_hf_config(path).hf_job_token_name is None


def test_selection_waits_for_auth_transaction_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.json"
    token_store_path = tmp_path / "stored_tokens"
    save_harbor_hf_tokens({"job-token": "secret-value"}, token_store_path)
    monkeypatch.setenv("HARBOR_HF_CONFIG", str(config_path))
    monkeypatch.setenv("HARBOR_HF_TOKEN_STORE", str(token_store_path))
    monkeypatch.setattr(
        "harbor_hf.credentials.verify_job_hf_token",
        lambda _token: {"owner": "owner", "role": "fineGrained"},
    )
    started = Event()

    def select() -> tuple[HarborHFConfig, VerifiedTokenIdentity]:
        started.set()
        return select_job_hf_token("job-token")

    with ThreadPoolExecutor(max_workers=1) as executor:
        with harbor_hf_auth_lock():
            future = executor.submit(select)
            assert started.wait(timeout=1)
            time.sleep(0.05)
            assert not future.done()
        config, identity = future.result(timeout=1)

    assert config.hf_job_token_name == "job-token"
    assert identity == {"owner": "owner", "role": "fineGrained"}


def test_verify_job_token_returns_safe_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeApi:
        def __init__(self, *, token: str) -> None:
            assert token == "secret"

        def whoami(self) -> dict[str, object]:
            return {
                "name": "owner",
                "auth": {"accessToken": {"role": "fineGrained"}},
            }

    monkeypatch.setattr("harbor_hf.credentials.HfApi", FakeApi)

    assert verify_job_hf_token("secret") == {
        "owner": "owner",
        "role": "fineGrained",
    }


def test_verify_job_token_requires_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeApi:
        def __init__(self, *, token: str) -> None:
            assert token == "secret"

        def whoami(self) -> dict[str, object]:
            return {
                "auth": {"accessToken": {"role": "fineGrained"}},
            }

    monkeypatch.setattr("harbor_hf.credentials.HfApi", FakeApi)

    with pytest.raises(ValueError, match="returned no owner"):
        verify_job_hf_token("secret")


def test_verify_job_token_requires_fine_grained_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeApi:
        def __init__(self, *, token: str) -> None:
            assert token == "secret"

        def whoami(self) -> dict[str, object]:
            return {
                "name": "owner",
                "auth": {"accessToken": {"role": "write"}},
            }

    monkeypatch.setattr("harbor_hf.credentials.HfApi", FakeApi)

    with pytest.raises(ValueError, match="fine-grained"):
        verify_job_hf_token("secret")

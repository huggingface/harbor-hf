from __future__ import annotations

import os
import time
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import harbor_hf.token_store as token_store_module
from harbor_hf.token_store import (
    harbor_hf_token_store_path,
    load_harbor_hf_tokens,
    remove_harbor_hf_token,
    save_harbor_hf_tokens,
    store_harbor_hf_token,
)


def _private_file(path: Path, content: bytes) -> None:
    path.write_bytes(content)
    path.chmod(0o600)


def test_token_store_path_prefers_explicit_override() -> None:
    assert (
        harbor_hf_token_store_path(
            {
                "HARBOR_HF_TOKEN_STORE": "~/private/tokens",
                "HARBOR_HF_CONFIG": "/ignored/config.json",
            }
        )
        == Path.home() / "private/tokens"
    )


def test_token_store_path_follows_config_directory() -> None:
    assert harbor_hf_token_store_path(
        {"HARBOR_HF_CONFIG": "/private/config.json"}
    ) == Path("/private/stored_tokens")


def test_token_store_path_uses_xdg_config_home() -> None:
    assert harbor_hf_token_store_path({"XDG_CONFIG_HOME": "/config"}) == Path(
        "/config/harbor-hf/stored_tokens"
    )


def test_missing_token_store_is_empty(tmp_path: Path) -> None:
    assert load_harbor_hf_tokens(tmp_path / "missing") == {}


def test_token_store_round_trip_is_sorted_and_private(tmp_path: Path) -> None:
    path = tmp_path / "private" / "stored_tokens"

    saved = save_harbor_hf_tokens({"second": "hf_second", "first": "hf_first"}, path)

    assert saved == path
    assert load_harbor_hf_tokens(path) == {
        "first": "hf_first",
        "second": "hf_second",
    }
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert (path.parent / ".stored_tokens.lock").stat().st_mode & 0o777 == 0o600
    assert path.read_text(encoding="utf-8") == (
        "[first]\nhf_token = hf_first\n\n[second]\nhf_token = hf_second\n\n"
    )


def test_store_requires_force_to_replace(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    store_harbor_hf_token("campaign", "hf_old", path=path)

    with pytest.raises(ValueError, match="--force"):
        store_harbor_hf_token("campaign", "hf_new", path=path)

    store_harbor_hf_token("campaign", "hf_new", replace=True, path=path)
    assert load_harbor_hf_tokens(path) == {"campaign": "hf_new"}


def test_remove_token_preserves_other_entries(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    save_harbor_hf_tokens({"first": "hf_one", "second": "hf_two"}, path)

    assert remove_harbor_hf_token("first", path=path) == path
    assert load_harbor_hf_tokens(path) == {"second": "hf_two"}


def test_remove_unknown_token_fails(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    save_harbor_hf_tokens({}, path)

    with pytest.raises(ValueError, match="is not saved"):
        remove_harbor_hf_token("missing", path=path)


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"not ini\n", "section headers"),
        (b"[same]\nhf_token=one\n[same]\nhf_token=two\n", "already exists"),
        (b"[DEFAULT]\nhf_token=secret\n", "DEFAULT values are forbidden"),
        (b"[name]\nother=secret\n", "must contain only hf_token"),
        (b"[name]\nHF_TOKEN=secret\n", "must contain only hf_token"),
        (b"[name]\nhf_token=\n", "must be nonempty"),
        (b"[ outer]\nhf_token=secret\n", "without outer whitespace"),
        (b"[name]\nhf_token=line\n continuation\n", "control characters"),
    ],
)
def test_load_rejects_malformed_store(
    tmp_path: Path, content: bytes, message: str
) -> None:
    path = tmp_path / "stored_tokens"
    _private_file(path, content)

    with pytest.raises(ValueError, match=message):
        load_harbor_hf_tokens(path)


def test_load_rejects_non_utf8_store(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    _private_file(path, b"\xff")

    with pytest.raises(ValueError, match="not UTF-8"):
        load_harbor_hf_tokens(path)


def test_load_rejects_oversized_store(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    _private_file(path, b" " * (1024 * 1024 + 1))

    with pytest.raises(ValueError, match="exceeds the 1 MiB limit"):
        load_harbor_hf_tokens(path)


@pytest.mark.parametrize("name", ["", " outer", "outer ", "line\nbreak", "DEFAULT"])
def test_save_rejects_unsafe_token_names(tmp_path: Path, name: str) -> None:
    with pytest.raises(ValueError, match="token name"):
        save_harbor_hf_tokens({name: "hf_secret"}, tmp_path / "stored_tokens")


@pytest.mark.parametrize("token", ["", " secret", "secret ", "line\nbreak"])
def test_save_rejects_unsafe_token_values(tmp_path: Path, token: str) -> None:
    with pytest.raises(ValueError, match="token value"):
        save_harbor_hf_tokens({"name": token}, tmp_path / "stored_tokens")


def test_save_rejects_oversized_token_value(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="token value exceeds the 16 KiB limit"):
        save_harbor_hf_tokens(
            {"name": "x" * (16 * 1024 + 1)}, tmp_path / "stored_tokens"
        )


def test_save_rejects_too_many_tokens(tmp_path: Path) -> None:
    tokens = {f"token-{index}": "secret" for index in range(257)}

    with pytest.raises(ValueError, match="exceeds the 256-token limit"):
        save_harbor_hf_tokens(tokens, tmp_path / "stored_tokens")


def test_save_rejects_oversized_encoded_store(tmp_path: Path) -> None:
    tokens = {f"token-{index}": "x" * 4096 for index in range(256)}

    with pytest.raises(ValueError, match="exceeds the 1 MiB limit"):
        save_harbor_hf_tokens(tokens, tmp_path / "private" / "stored_tokens")


def test_load_rejects_insecure_file_permissions(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    path.write_text("[name]\nhf_token=secret\n", encoding="utf-8")
    path.chmod(0o644)

    with pytest.raises(ValueError, match="permissions must be 0600"):
        load_harbor_hf_tokens(path)


def test_load_rejects_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target"
    _private_file(target, b"[name]\nhf_token=secret\n")
    link = tmp_path / "stored_tokens"
    link.symlink_to(target)

    with pytest.raises(ValueError, match="cannot be a symlink"):
        load_harbor_hf_tokens(link)


def test_load_rejects_nonregular_file(tmp_path: Path) -> None:
    path = tmp_path / "stored_tokens"
    path.mkdir()

    with pytest.raises(ValueError, match="must be a regular file"):
        load_harbor_hf_tokens(path)


def test_save_rejects_symlinked_store_directory(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "linked"
    link.symlink_to(real, target_is_directory=True)

    with pytest.raises(ValueError, match="directory cannot be a symlink"):
        save_harbor_hf_tokens({"name": "secret"}, link / "stored_tokens")


def test_save_rejects_insecure_store_directory(tmp_path: Path) -> None:
    parent = tmp_path / "insecure"
    parent.mkdir(mode=0o755)
    parent.chmod(0o755)

    with pytest.raises(ValueError, match="permissions must be 0700"):
        save_harbor_hf_tokens({"name": "secret"}, parent / "stored_tokens")


def test_load_rejects_insecure_store_directory(tmp_path: Path) -> None:
    parent = tmp_path / "insecure"
    parent.mkdir(mode=0o700)
    path = parent / "stored_tokens"
    _private_file(path, b"[name]\nhf_token=secret\n")
    parent.chmod(0o755)

    with pytest.raises(ValueError, match="permissions must be 0700"):
        load_harbor_hf_tokens(path)


def test_concurrent_updates_preserve_every_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "private" / "stored_tokens"
    original_save = token_store_module._save_harbor_hf_tokens_unlocked

    def delayed_save(tokens: Mapping[str, str], destination: Path) -> Path:
        time.sleep(0.01)
        return original_save(tokens, destination)

    monkeypatch.setattr(
        token_store_module, "_save_harbor_hf_tokens_unlocked", delayed_save
    )
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(
                store_harbor_hf_token,
                f"token-{index}",
                f"secret-{index}",
                path=path,
            )
            for index in range(16)
        ]
        for future in futures:
            future.result()

    assert load_harbor_hf_tokens(path) == {
        f"token-{index}": f"secret-{index}" for index in range(16)
    }


def test_failed_atomic_replace_removes_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parent = tmp_path / "private"
    parent.mkdir(mode=0o700)
    path = parent / "stored_tokens"

    def fail_replace(_source: object, _destination: object) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr(os, "replace", fail_replace)

    with pytest.raises(OSError, match="replace failed"):
        save_harbor_hf_tokens({"name": "secret"}, path)

    assert [entry.name for entry in parent.iterdir()] == [".stored_tokens.lock"]

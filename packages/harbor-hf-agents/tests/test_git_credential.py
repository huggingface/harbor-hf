from __future__ import annotations

import io
import os
import subprocess
import sys

import pytest

from harbor_hf_agents import git_credential

TOKEN = "test-" + "credential-value"


def test_get_returns_the_token_only_for_the_exact_hugging_face_host() -> None:
    assert git_credential.credential_response(
        "get",
        {"protocol": "https", "host": "huggingface.co"},
        TOKEN,
    ) == {"username": "hf_user", "password": TOKEN}

    for fields in (
        {"protocol": "http", "host": "huggingface.co"},
        {"protocol": "https", "host": "HUGGINGFACE.CO"},
        {"protocol": "https", "host": "huggingface.co:443"},
        {"protocol": "https", "host": "subdomain.huggingface.co"},
        {"protocol": "https", "host": "example.com"},
    ):
        assert git_credential.credential_response("get", fields, TOKEN) == {}


def test_missing_token_fails_only_for_the_admitted_host() -> None:
    with pytest.raises(git_credential.CredentialError, match="HF_TOKEN is required"):
        git_credential.credential_response(
            "get", {"protocol": "https", "host": "huggingface.co"}, None
        )
    assert (
        git_credential.credential_response(
            "get", {"protocol": "https", "host": "example.com"}, None
        )
        == {}
    )


@pytest.mark.parametrize("token", ["line\nbreak", "line\rbreak", "null\0byte"])
def test_protocol_control_characters_in_token_are_rejected(token: str) -> None:
    with pytest.raises(git_credential.CredentialError, match="not valid"):
        git_credential.credential_response(
            "get", {"protocol": "https", "host": "huggingface.co"}, token
        )


def test_repeated_git_capability_fields_are_accepted() -> None:
    fields = git_credential._read_request(
        io.StringIO(
            "protocol=https\nhost=huggingface.co\nwwwauth[]=first\nwwwauth[]=second\n\n"
        )
    )
    assert fields["protocol"] == "https"
    assert fields["host"] == "huggingface.co"


def test_git_uses_the_host_scoped_helper(tmp_path) -> None:
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "HF_TOKEN": TOKEN,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
        "GIT_CONFIG_KEY_1": "credential.https://huggingface.co.helper",
        "GIT_CONFIG_VALUE_1": "harbor-hf",
    }
    result = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=huggingface.co\n\n",
        text=True,
        capture_output=True,
        check=False,
        env=environment,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == (
        f"protocol=https\nhost=huggingface.co\nusername=hf_user\npassword={TOKEN}\n"
    )


def test_store_and_erase_never_persist_credentials(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    fields = {
        "protocol": "https",
        "host": "huggingface.co",
        "username": "hf_user",
        "password": TOKEN,
    }
    assert git_credential.credential_response("store", fields, TOKEN) == {}
    assert git_credential.credential_response("erase", fields, TOKEN) == {}
    assert list(tmp_path.iterdir()) == []


def test_helper_protocol_emits_no_secret_for_an_unmatched_host(
    monkeypatch, capsys
) -> None:
    monkeypatch.setattr(sys, "argv", ["git-credential-harbor-hf", "get"])
    monkeypatch.setattr(
        sys, "stdin", io.StringIO("protocol=https\nhost=example.com\n\n")
    )
    monkeypatch.setenv("HF_TOKEN", TOKEN)

    git_credential.main()

    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == ""
    assert TOKEN not in output.out + output.err


def test_helper_protocol_returns_the_ephemeral_credential(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "argv", ["git-credential-harbor-hf", "get"])
    monkeypatch.setattr(
        sys, "stdin", io.StringIO("protocol=https\nhost=huggingface.co\n\n")
    )
    monkeypatch.setenv("HF_TOKEN", TOKEN)

    git_credential.main()

    output = capsys.readouterr()
    assert output.out == f"username=hf_user\npassword={TOKEN}\n\n"
    assert output.err == ""


def test_malformed_requests_fail_without_disclosing_the_token(
    monkeypatch, capsys
) -> None:
    monkeypatch.setattr(sys, "argv", ["git-credential-harbor-hf", "get"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("host\n"))
    monkeypatch.setenv("HF_TOKEN", TOKEN)

    with pytest.raises(SystemExit, match="1"):
        git_credential.main()

    output = capsys.readouterr()
    assert "malformed" in output.err
    assert TOKEN not in output.out + output.err

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from harbor_hf_agents.support import sandbox_root_bridge


def test_starts_bridge_and_writes_only_loopback_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    output = tmp_path / "route.json"
    token = tmp_path / "token"
    monkeypatch.setattr(
        sandbox_root_bridge,
        "Path",
        lambda value: token if str(value).endswith(".token") else output,
    )
    for key, value in {
        "HF_INFERENCE_TOKEN": "private-inference-token",
        "HARBOR_HF_INFERENCE_UPSTREAM": "https://router.huggingface.co/v1",
        "HARBOR_HF_INFERENCE_ALLOWED_MODEL": "example/model",
        "HARBOR_HF_INFERENCE_API": "chat-completions",
        "HARBOR_HF_INFERENCE_MAX_REQUESTS": "8",
        "HARBOR_HF_INFERENCE_MAX_CONCURRENCY": "1",
        "HARBOR_HF_INFERENCE_TIMEOUT_SECONDS": "300",
        "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS": "1024",
    }.items():
        monkeypatch.setenv(key, value)
    calls: list[dict[str, str]] = []

    def run(_command: list[str], *, check: bool, env: dict[str, str]) -> object:
        assert check is True
        calls.append(env)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(sandbox_root_bridge.subprocess, "run", run)

    sandbox_root_bridge.main()

    assert "HF_INFERENCE_TOKEN" not in calls[0]
    assert "HARBOR_HF_INFERENCE_TOKEN" not in calls[0]
    assert calls[0]["HARBOR_HF_INFERENCE_TOKEN_FILE"] == str(token)
    assert token.read_text() == "private-inference-token"
    assert token.stat().st_mode & 0o777 == 0o600
    value = json.loads(output.read_text())
    assert value == {
        "schema_version": "v1",
        "api": "chat-completions",
        "base_url": "http://127.0.0.1:18080/v1",
        "api_key": "harbor-local-inference-bridge",
        "model": "example/model",
    }
    assert "token" not in output.read_text().lower()
    assert output.stat().st_mode & 0o777 == 0o644


def test_rejects_unknown_api(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_INFERENCE_API", "unknown")

    with pytest.raises(RuntimeError, match="API is invalid"):
        sandbox_root_bridge.main()

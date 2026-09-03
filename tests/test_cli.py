from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import httpx
import pytest
from typer.testing import CliRunner

from harbor_hf.cli import app

runner = CliRunner()


def response(status: int, body: dict[str, object]) -> httpx.Response:
    return httpx.Response(
        status, json=body, request=httpx.Request("GET", "https://control.example/api")
    )


def configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "https://control.example")
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "test-token")


def test_cli_does_not_forward_the_local_hugging_face_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "https://control.example")
    monkeypatch.setenv("HF_TOKEN", "local-token-must-not-be-forwarded")
    monkeypatch.delenv("HARBOR_HF_CONTROL_BEARER_TOKEN", raising=False)

    result = runner.invoke(app, ["status"])

    assert result.exit_code != 0
    assert "purpose-scoped control credential" in result.output
    assert "local-token-must-not-be-forwarded" not in result.output


def test_status_reads_control_api(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch)
    calls: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        calls.append((method, url))
        return response(200, {"write_mode": "enabled"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(app, ["status"])

    assert result.exit_code == 0
    assert json.loads(result.stdout) == {"write_mode": "enabled"}
    assert calls == [("GET", "https://control.example/api/v1/system")]


def test_run_submit_sends_profile_references(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(202, {"run_id": "run-one", "action_id": "action-one"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "run",
            "submit",
            "--benchmark",
            "control-smoke",
            "--model",
            "control-smoke",
            "--harness",
            "control-smoke",
            "--deployment",
            "hf-cpu-smoke",
            "--launch-policy",
            "control-smoke",
            "--ceiling-microusd",
            "0",
            "--idempotency-key",
            "request-key-0001",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["run_id"] == "run-one"
    assert observed["method"] == "POST"
    assert observed["url"] == "https://control.example/api/v1/runs"
    assert observed["json"] == {
        "benchmark": "control-smoke",
        "model": "control-smoke",
        "harness": "control-smoke",
        "deployment": "hf-cpu-smoke",
        "launch_policy": "control-smoke",
        "ceiling_microusd": 0,
        "confirmed": True,
    }
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == "request-key-0001"


def test_run_submit_sends_tested_workbench_recipe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}
    recipe = {
        "schema_version": "v1",
        "name": "test-agent",
        "setup_command": "printf setup",
        "run_command": "printf run",
        "route_api": "chat-completions",
        "setup_timeout_seconds": 60,
        "environment": [],
        "outputs": {
            "results_path": "/logs/agent/results.json",
            "trajectory_path": None,
        },
    }
    recipe_path = tmp_path / "harness.json"
    recipe_path.write_text(json.dumps(recipe), encoding="utf-8")

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        if method == "GET":
            return response(
                200,
                {
                    "items": [
                        {
                            "name": "tb21-gpt-oss-20b-canary",
                            "revision": f"sha256:{'1' * 64}",
                        }
                    ]
                },
            )
        return response(202, {"run_id": "run-workbench", "action_id": "action-one"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "run",
            "submit",
            "--config",
            "tb21-gpt-oss-20b-canary",
            "--harness",
            str(recipe_path),
            "--setup-test",
            "setup-test-cli",
            "--ceiling-microusd",
            "1000000",
            "--idempotency-key",
            "workbench-request-key",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert observed["json"] == {
        "benchmark_config": "tb21-gpt-oss-20b-canary",
        "benchmark_config_revision": f"sha256:{'1' * 64}",
        "harness": {
            "type": "workbench",
            "recipe": recipe,
            "setup_test_id": "setup-test-cli",
        },
        "ceiling_microusd": 1_000_000,
        "confirmed": True,
    }


def test_run_submit_can_start_paused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(202, {"run_id": "run-one", "action_id": "action-one"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "run",
            "submit",
            "--benchmark",
            "control-smoke",
            "--model",
            "control-smoke",
            "--harness",
            "control-smoke",
            "--deployment",
            "hf-cpu-smoke",
            "--launch-policy",
            "control-smoke",
            "--ceiling-microusd",
            "0",
            "--idempotency-key",
            "request-key-0002",
            "--start-paused",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    payload = cast(dict[str, object], observed["json"])
    assert payload["start_paused"] is True


def test_historical_run_continuation_uses_stable_idempotency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(
            202,
            {
                "run_id": "run-one",
                "continuation_id": "continuation-one",
                "adopted": False,
            },
        )

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "run",
            "continue-historical",
            "run-one",
            "--reason",
            "finish unresolved tasks",
            "--idempotency-key",
            "continuation-key-0001",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert observed["url"] == "https://control.example/api/v1/runs/run-one/continuation"
    assert observed["json"] == {
        "reason": "finish unresolved tasks",
        "confirmed": True,
    }
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == "continuation-key-0001"


def test_historical_run_repair_successor_uses_stable_idempotency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(
            202,
            {
                "run_id": "run-one",
                "continuation_repair_successor_id": "successor-one",
                "adopted": False,
            },
        )

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "run",
            "repair-continuation-successor",
            "run-one",
            "--reason",
            "replace the digest-defective worker",
            "--idempotency-key",
            "successor-key-0001",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert (
        observed["url"]
        == "https://control.example/api/v1/runs/run-one/continuation-repair-successor"
    )
    assert observed["json"] == {
        "reason": "replace the digest-defective worker",
        "confirmed": True,
    }
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == "successor-key-0001"


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        (
            ["pause", "run-one", "--reason", "canary boundary", "--yes"],
            {
                "action": "pause",
                "task_id": None,
                "reason": "canary boundary",
                "confirmed": True,
            },
        ),
        (
            [
                "retry-infrastructure",
                "run-one",
                "--task",
                "task-one",
                "--reason",
                "transient infrastructure failure",
                "--yes",
            ],
            {
                "action": "retry_infrastructure",
                "task_id": "task-one",
                "reason": "transient infrastructure failure",
                "confirmed": True,
            },
        ),
        (
            [
                "retry-infrastructure",
                "run-one",
                "--all-eligible",
                "--reason",
                "retry eligible infrastructure failures",
                "--yes",
            ],
            {
                "action": "retry_infrastructure",
                "task_id": None,
                "reason": "retry eligible infrastructure failures",
                "confirmed": True,
            },
        ),
        (
            [
                "resume",
                "run-one",
                "--task-limit",
                "1",
                "--reason",
                "run canary",
                "--yes",
            ],
            {
                "action": "resume",
                "task_id": None,
                "reason": "run canary",
                "confirmed": True,
                "task_limit": 1,
            },
        ),
        (
            [
                "supersede",
                "run-one",
                "--publication",
                "publication-old",
                "--reason",
                "valid replacement",
                "--yes",
            ],
            {
                "action": "supersede",
                "task_id": None,
                "reason": "valid replacement",
                "confirmed": True,
                "publication_id": "publication-old",
            },
        ),
    ],
)
def test_run_lifecycle_actions_use_control_api(
    monkeypatch: pytest.MonkeyPatch,
    arguments: list[str],
    expected: dict[str, object],
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(202, {"run_id": "run-one", "action_id": "action-one"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(app, ["run", *arguments])

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert observed["url"] == ("https://control.example/api/v1/runs/run-one/actions")
    assert observed["json"] == expected


def test_retry_infrastructure_requires_task_or_all_eligible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    result = runner.invoke(
        app,
        ["run", "retry-infrastructure", "run-one", "--yes"],
    )
    assert result.exit_code != 0
    assert json.loads(result.output) == {
        "error": "provide exactly one of --task or --all-eligible"
    }


def test_run_pause_endpoint_uses_confirmed_control_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(202, {"run_id": "run-one", "action_id": "action-one"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "run",
            "pause-endpoint",
            "run-one",
            "--reason",
            "terminal cleanup",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert observed["url"] == ("https://control.example/api/v1/runs/run-one/actions")
    assert observed["json"] == {
        "action": "pause_endpoint",
        "task_id": None,
        "reason": "terminal cleanup",
        "confirmed": True,
    }


def test_run_rejects_retired_action_correction_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    result = runner.invoke(
        app,
        ["run", "correct-action-dispositions", "run-one"],
    )
    assert result.exit_code == 2
    assert "No such command" in result.output


def test_run_help_omits_retired_action_correction_command() -> None:
    result = runner.invoke(app, ["run", "--help"])
    assert result.exit_code == 0
    assert "correct-action-dispositions" not in result.output


def test_capacity_reads_control_api(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch)
    calls: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        calls.append((method, url))
        return response(200, {"max_active_jobs": 16, "configured": True})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(app, ["capacity"])

    assert result.exit_code == 0
    assert json.loads(result.stdout) == {
        "configured": True,
        "max_active_jobs": 16,
    }
    assert calls == [("GET", "https://control.example/api/v1/capacity")]


def test_capacity_set_sends_confirmed_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(200, {"max_active_jobs": 128, "configured": True})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        ["capacity", "set", "--max-jobs", "128", "--yes"],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["max_active_jobs"] == 128
    assert observed["method"] == "POST"
    assert observed["url"] == "https://control.example/api/v1/capacity"
    assert observed["json"] == {
        "max_active_jobs": 128,
        "confirmed": True,
    }
    headers = cast(dict[str, str], observed["headers"])
    assert "Idempotency-Key" in headers


def test_cli_reports_safe_api_error(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            503,
            {
                "error": {
                    "code": "control_not_ready",
                    "message": "projection is rebuilding",
                }
            },
        ),
    )

    result = runner.invoke(app, ["run", "list"])

    assert result.exit_code == 1
    assert "projection is rebuilding" in result.stderr
    assert "test-token" not in result.stderr


def test_cli_rejects_insecure_remote_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "http://control.example")
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "test-token")

    result = runner.invoke(app, ["status"])

    assert result.exit_code != 0
    assert "must use HTTPS" in result.output

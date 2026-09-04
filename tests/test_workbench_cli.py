from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import cast

import httpx
import pytest
import typer
from typer.testing import CliRunner

import harbor_hf.cli as cli
from harbor_hf.cli import app
from harbor_hf.workbench_cli import TransientControlError, _write_private_text

runner = CliRunner()


def response(status: int, body: object) -> httpx.Response:
    return httpx.Response(
        status,
        json=body,
        request=httpx.Request("GET", "https://control.example/api"),
    )


def configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "https://control.example")
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "test-token")


def recipe() -> dict[str, object]:
    return {
        "schema_version": "v1",
        "name": "example-agent",
        "setup_command": "install-agent",
        "run_command": "run-agent",
        "route_api": "chat-completions",
        "setup_timeout_seconds": 600,
        "environment": [
            {"name": "MODEL_BASE_URL", "source": "model_base_url"},
            {"name": "MODEL_API_KEY", "source": "model_api_key"},
        ],
        "outputs": {
            "results_path": "/logs/agent/results.json",
            "trajectory_path": None,
        },
    }


def write_recipe(path: Path) -> None:
    path.write_text(json.dumps(recipe()), encoding="utf-8")


def setup_value(status: str = "queued") -> dict[str, object]:
    return {
        "setup_test_id": "setup-one",
        "recipe_digest": "a" * 64,
        "revision_id": "revision-one",
        "status": status,
        "created_at": "2026-01-01T00:00:00Z",
        "started_at": None,
        "completed_at": None,
        "exit_code": 0 if status == "passed" else None,
        "error": None,
        "files": [],
    }


def test_workbench_help_keeps_only_current_commands() -> None:
    result = runner.invoke(app, ["workbench", "--help"])

    assert result.exit_code == 0
    assert "preview" in result.output
    assert "setup" in result.output
    assert "publication" not in result.output
    assert "profile" not in result.output


def test_workbench_preview_sends_the_exact_recipe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(200, {"recipe_digest": "a" * 64})

    monkeypatch.setattr(httpx, "request", request)
    result = runner.invoke(app, ["workbench", "preview", str(source)])

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert observed["url"] == "https://control.example/api/v1/workbench/preview"
    assert observed["json"] == recipe()
    assert "test-token" not in result.output


def test_workbench_rejects_bad_or_oversize_input_before_http(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    called = False

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return response(200, {})

    monkeypatch.setattr(httpx, "request", request)
    invalid = tmp_path / "invalid.json"
    invalid.write_text("[]", encoding="utf-8")
    oversize = tmp_path / "oversize.json"
    oversize.write_bytes(b"{" + b"x" * (1024 * 1024))

    assert runner.invoke(app, ["workbench", "preview", str(invalid)]).exit_code == 1
    assert runner.invoke(app, ["workbench", "preview", str(oversize)]).exit_code == 1
    assert called is False


def test_setup_start_uses_one_confirmed_recipe_and_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(202, setup_value())

    monkeypatch.setattr(httpx, "request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "start",
            str(source),
            "--idempotency-key",
            "setup-key",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == "setup-key"
    assert observed["json"] == {"recipe": recipe()}
    assert "confirmed" not in json.dumps(observed["json"])


def test_setup_start_from_stdin_requires_explicit_confirmation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    result = runner.invoke(
        app,
        ["workbench", "setup", "start", "-"],
        input=json.dumps(recipe()),
    )

    assert result.exit_code == 1
    assert "--yes" in result.output


def test_setup_list_unwraps_the_actor_collection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(200, {"setups": [setup_value("passed")]}),
    )

    result = runner.invoke(app, ["workbench", "setup", "list"])

    assert result.exit_code == 0
    assert json.loads(result.stdout)[0]["status"] == "passed"


def test_setup_status_and_files_encode_untrusted_identifiers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    urls: list[str] = []

    def request(_method: str, url: str, **_kwargs: object) -> httpx.Response:
        urls.append(url)
        if "/files/" in url:
            return response(200, {"content": "safe", "truncated": False})
        return response(200, setup_value("passed"))

    monkeypatch.setattr(httpx, "request", request)
    assert (
        runner.invoke(
            app, ["workbench", "setup", "status", "setup/with space"]
        ).exit_code
        == 0
    )
    assert (
        runner.invoke(
            app,
            ["workbench", "setup", "file", "setup/with space", "file/name"],
        ).exit_code
        == 0
    )
    assert urls == [
        "https://control.example/api/v1/workbench/setup-tests/setup%2Fwith%20space",
        "https://control.example/api/v1/workbench/setup-tests/setup%2Fwith%20space/files/file%2Fname",
    ]


def test_setup_wait_retries_transient_failures_and_stops_on_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    values: list[object] = [
        TransientControlError(),
        setup_value("running"),
        setup_value("passed"),
    ]

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        value = values.pop(0)
        if isinstance(value, Exception):
            raise value
        return response(200, value)

    monkeypatch.setattr(httpx, "request", request)
    monkeypatch.setattr("harbor_hf.workbench_cli.time.sleep", lambda _value: None)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "wait",
            "setup-one",
            "--poll-interval",
            "0.2",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["status"] == "passed"
    assert values == []


def test_setup_wait_fails_for_a_terminal_setup_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(200, setup_value("failed")),
    )

    result = runner.invoke(app, ["workbench", "setup", "wait", "setup-one"])

    assert result.exit_code == 1
    assert json.loads(result.stdout)["status"] == "failed"


def test_setup_cancel_targets_only_the_named_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        observed.append((method, url))
        return response(200, setup_value("cancelled"))

    monkeypatch.setattr(httpx, "request", request)
    result = runner.invoke(app, ["workbench", "setup", "cancel", "setup-one", "--yes"])

    assert result.exit_code == 0
    assert observed == [
        (
            "POST",
            "https://control.example/api/v1/workbench/setup-tests/setup-one/cancel",
        )
    ]


@pytest.mark.parametrize(
    ("channel", "expected"),
    [
        ("stdout", "out\n"),
        ("stderr", "err\n"),
        ("combined", "out\n\n[stderr]\nerr\n"),
    ],
)
def test_setup_logs_supports_raw_channels(
    monkeypatch: pytest.MonkeyPatch,
    channel: str,
    expected: str,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(200, {"stdout": "out\n", "stderr": "err\n"}),
    )

    result = runner.invoke(
        app,
        ["workbench", "setup", "logs", "setup-one", "--channel", channel],
    )

    assert result.exit_code == 0
    assert result.stdout == expected


def test_setup_file_writes_owner_only_and_refuses_truncation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    truncated = False

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        return response(200, {"content": "safe\n", "truncated": truncated})

    monkeypatch.setattr(httpx, "request", request)
    destination = tmp_path / "preview.txt"
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "file",
            "setup-one",
            "file-one",
            "--output",
            str(destination),
        ],
    )
    assert result.exit_code == 0
    assert destination.read_text(encoding="utf-8") == "safe\n"
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600

    destination.unlink()
    truncated = True
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "file",
            "setup-one",
            "file-one",
            "--output",
            str(destination),
        ],
    )
    assert result.exit_code == 1
    assert "--allow-truncated" in result.output
    assert not destination.exists()


def test_recipe_reader_reports_file_encoding_and_json_errors(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    missing = tmp_path / "missing.json"
    invalid_utf8 = tmp_path / "invalid-utf8.json"
    invalid_utf8.write_bytes(b"\xff")
    invalid_json = tmp_path / "invalid-json.json"
    invalid_json.write_text("{", encoding="utf-8")

    missing_result = runner.invoke(app, ["workbench", "preview", str(missing)])
    encoding_result = runner.invoke(app, ["workbench", "preview", str(invalid_utf8)])
    json_result = runner.invoke(app, ["workbench", "preview", str(invalid_json)])

    assert "could not be read" in missing_result.output
    assert "UTF-8 JSON" in encoding_result.output
    assert "valid JSON" in json_result.output


def test_setup_start_reports_a_generated_key_and_validates_wait_response(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(202, {"status": "queued"}),
    )

    result = runner.invoke(
        app,
        ["workbench", "setup", "start", str(source), "--yes", "--wait"],
    )

    assert result.exit_code == 1
    assert "idempotency_key" in result.stderr
    assert "invalid setup response" in result.stderr


def test_setup_collection_logs_and_file_shape_errors_are_rejected(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(200, {}),
    )

    collection = runner.invoke(app, ["workbench", "setup", "list"])
    logs = runner.invoke(
        app,
        ["workbench", "setup", "logs", "setup-one", "--channel", "stdout"],
    )
    files = runner.invoke(app, ["workbench", "setup", "files", "setup-one"])
    file_result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "file",
            "setup-one",
            "file-one",
            "--output",
            str(tmp_path / "file.txt"),
        ],
    )

    assert "invalid setup collection" in collection.stderr
    assert "invalid setup logs" in logs.stderr
    assert "invalid setup file list" in files.stderr
    assert "invalid setup file content" in file_result.stderr


def test_setup_cancel_can_wait_for_the_exact_cancelled_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    values = iter([setup_value("cancelling"), setup_value("cancelled")])
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(200, next(values)),
    )
    monkeypatch.setattr("harbor_hf.workbench_cli.time.sleep", lambda _value: None)

    result = runner.invoke(
        app,
        ["workbench", "setup", "cancel", "setup-one", "--yes", "--wait"],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["status"] == "cancelled"


def test_private_file_write_does_not_replace_an_existing_file(tmp_path: Path) -> None:
    destination = tmp_path / "existing.txt"
    destination.write_text("original", encoding="utf-8")

    with pytest.raises(typer.Exit):
        _write_private_text(
            destination,
            "replacement",
            force=False,
            fail=lambda message, code: cli._fail(message, code),
        )

    assert destination.read_text(encoding="utf-8") == "original"
    assert not list(tmp_path.glob("*.harbor-hf-tmp"))

from __future__ import annotations

import json
import stat
from collections.abc import Callable
from pathlib import Path
from typing import cast

import httpx
import pytest
from typer.testing import CliRunner

from harbor_hf.cli import app
from harbor_hf.workbench_cli import _profile_items, _write_private_text

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
        "environment": [],
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
        "recipe_digest": "sha256:recipe",
        "revision_id": "revision-one",
        "status": status,
        "created_at": "2026-01-01T00:00:00Z",
        "started_at": None,
        "completed_at": None,
        "exit_code": None,
        "error": None,
        "files": [],
    }


def test_workbench_help_exposes_generic_commands() -> None:
    result = runner.invoke(app, ["workbench", "--help"])

    assert result.exit_code == 0
    assert "preview" in result.output
    assert "setup" in result.output
    assert "publication" in result.output
    assert "fast-agent" not in result.output


def test_workbench_preview_sends_recipe_object(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(200, {"recipe_digest": "sha256:recipe"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(app, ["workbench", "preview", str(source)])

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert observed["url"] == "https://control.example/api/v1/workbench/preview"
    assert observed["json"] == recipe()


def test_workbench_preview_reads_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(200, {"recipe_digest": "sha256:recipe"})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        ["workbench", "preview", "-"],
        input=json.dumps(recipe()),
    )

    assert result.exit_code == 0
    assert observed["json"] == recipe()


@pytest.mark.parametrize("document", ["{", "[]", '"recipe"'])
def test_workbench_rejects_invalid_recipe_before_http(
    monkeypatch: pytest.MonkeyPatch,
    document: str,
) -> None:
    configure(monkeypatch)
    called = False

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return response(500, {})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(app, ["workbench", "preview", "-"], input=document)

    assert result.exit_code == 1
    assert called is False


def test_workbench_setup_start_sends_confirmed_recipe(
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

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "start",
            str(source),
            "--idempotency-key",
            "setup-key-0001",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert observed["url"] == "https://control.example/api/v1/workbench/setup-tests"
    assert observed["json"] == {"recipe": recipe(), "confirmed": True}
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == "setup-key-0001"


def test_workbench_setup_start_reports_generated_key_only_on_stderr(
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

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        ["workbench", "setup", "start", str(source), "--yes"],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["setup_test_id"] == "setup-one"
    generated = json.loads(result.stderr)["idempotency_key"]
    assert 8 <= len(generated) <= 256
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == generated


@pytest.mark.parametrize("key", ["short", "x" * 257])
def test_workbench_setup_start_rejects_invalid_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    key: str,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    called = False

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return response(202, setup_value())

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "start",
            str(source),
            "--idempotency-key",
            key,
            "--yes",
        ],
    )

    assert result.exit_code == 1
    assert called is False


def test_workbench_setup_start_from_stdin_requires_yes(
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


def test_workbench_setup_list_reads_actor_collection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    calls: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        calls.append((method, url))
        return response(200, [setup_value("passed")])

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(app, ["workbench", "setup", "list"])

    assert result.exit_code == 0
    assert json.loads(result.stdout)[0]["status"] == "passed"
    assert calls == [("GET", "https://control.example/api/v1/workbench/setup-tests")]


def test_workbench_setup_commands_encode_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    calls: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        calls.append((method, url))
        return response(200, setup_value("passed"))

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        ["workbench", "setup", "status", "setup/with space"],
    )

    assert result.exit_code == 0
    assert calls == [
        (
            "GET",
            "https://control.example/api/v1/workbench/setup-tests/setup%2Fwith%20space",
        )
    ]


def test_workbench_setup_wait_polls_until_passed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    values = iter([setup_value("running"), setup_value("passed")])

    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(200, next(values)),
    )
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


def test_workbench_setup_wait_retries_one_transient_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    values: list[httpx.Response | httpx.HTTPError] = [
        httpx.ConnectError("temporary connection failure"),
        response(200, setup_value("passed")),
    ]

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        value = values.pop(0)
        if isinstance(value, httpx.HTTPError):
            raise value
        return value

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
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


def test_workbench_setup_wait_retries_one_transient_http_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    values = iter(
        [
            response(
                503,
                {
                    "error": {
                        "code": "control_not_ready",
                        "message": "projection is rebuilding",
                    }
                },
            ),
            response(200, setup_value("passed")),
        ]
    )
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: next(values),
    )
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


def test_workbench_setup_start_can_wait_for_accepted_setup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    values = iter(
        [
            response(202, setup_value("queued")),
            response(200, setup_value("running")),
            response(200, setup_value("passed")),
        ]
    )
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: next(values),
    )
    monkeypatch.setattr("harbor_hf.workbench_cli.time.sleep", lambda _value: None)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "start",
            str(source),
            "--idempotency-key",
            "setup-key-0001",
            "--wait",
            "--poll-interval",
            "0.2",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["status"] == "passed"


def test_workbench_setup_wait_exits_nonzero_for_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(200, setup_value("failed")),
    )
    result = runner.invoke(app, ["workbench", "setup", "wait", "setup-one"])

    assert result.exit_code == 1
    assert json.loads(result.stdout)["status"] == "failed"


def test_workbench_setup_wait_timeout_does_not_cancel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    calls: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        calls.append((method, url))
        return response(200, setup_value("running"))

    monotonic = iter([0.0, 0.0, 2.0])
    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    monkeypatch.setattr(
        "harbor_hf.workbench_cli.time.monotonic", lambda: next(monotonic)
    )
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "wait",
            "setup-one",
            "--timeout-seconds",
            "1",
        ],
    )

    assert result.exit_code == 1
    assert "without cancelling" in result.output
    assert calls == [
        (
            "GET",
            "https://control.example/api/v1/workbench/setup-tests/setup-one",
        )
    ]


def test_workbench_setup_cancel_uses_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    observed: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        observed.update({"method": method, "url": url, **kwargs})
        return response(200, setup_value("cancelled"))

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "cancel",
            "setup-one",
            "--idempotency-key",
            "cancel-key-0001",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert observed["method"] == "POST"
    assert str(observed["url"]).endswith("/setup-one/cancel")
    assert observed["json"] == {"confirmed": True}
    headers = cast(dict[str, str], observed["headers"])
    assert headers["Idempotency-Key"] == "cancel-key-0001"


def test_workbench_setup_cancel_can_wait_until_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    values = iter(
        [
            response(200, setup_value("cancelling")),
            response(200, setup_value("cancelled")),
        ]
    )
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: next(values),
    )
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "cancel",
            "setup-one",
            "--idempotency-key",
            "cancel-key-0001",
            "--wait",
            "--yes",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["status"] == "cancelled"


def test_workbench_setup_logs_can_emit_one_raw_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"stdout": "setup output\n", "stderr": "warning\n"}
        ),
    )
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "logs",
            "setup-one",
            "--channel",
            "stdout",
        ],
    )

    assert result.exit_code == 0
    assert result.stdout == "setup output\n"


def test_workbench_setup_logs_can_emit_json_and_combined(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"stdout": "setup output", "stderr": "warning"}
        ),
    )

    json_result = runner.invoke(
        app,
        ["workbench", "setup", "logs", "setup-one"],
    )
    combined_result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "logs",
            "setup-one",
            "--channel",
            "combined",
        ],
    )

    assert json_result.exit_code == 0
    assert json.loads(json_result.stdout)["stderr"] == "warning"
    assert combined_result.exit_code == 0
    assert combined_result.stdout == "setup output\n[stderr]\nwarning"


def test_workbench_setup_logs_preserves_ansi_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    text = "\x1b[31merror\x1b[0m"
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(200, {"stdout": text, "stderr": ""}),
    )
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "logs",
            "setup-one",
            "--channel",
            "stdout",
        ],
        color=False,
    )

    assert result.exit_code == 0
    assert result.stdout_bytes == text.encode()


def test_workbench_setup_logs_rejects_unknown_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    called = False

    def request(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return response(200, {"stdout": "", "stderr": ""})

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "setup",
            "logs",
            "setup-one",
            "--channel",
            "unknown",
        ],
    )

    assert result.exit_code == 2
    assert "Invalid value" in result.output
    assert called is False


def test_workbench_setup_files_extracts_file_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    value = setup_value("passed")
    value["files"] = [
        {
            "file_id": "file-one",
            "path": "setup.log",
            "root": "logs",
            "size": 12,
            "text": True,
        }
    ]
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(200, value),
    )
    result = runner.invoke(
        app,
        ["workbench", "setup", "files", "setup-one"],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout) == value["files"]


def test_workbench_setup_file_writes_owner_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    destination = tmp_path / "setup.log"
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"content": "setup output\n", "truncated": False}
        ),
    )
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
    assert destination.read_text() == "setup output\n"
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_workbench_setup_file_defaults_to_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"content": "setup output\n", "truncated": False}
        ),
    )
    result = runner.invoke(
        app,
        ["workbench", "setup", "file", "setup-one", "file-one"],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["content"] == "setup output\n"


def test_workbench_setup_file_refuses_overwrite_without_force(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    destination = tmp_path / "setup.log"
    destination.write_text("preserve", encoding="utf-8")
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"content": "replacement", "truncated": False}
        ),
    )
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
    assert destination.read_text() == "preserve"


def test_workbench_setup_file_refuses_truncated_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    destination = tmp_path / "setup.log"
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"content": "partial", "truncated": True}
        ),
    )
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
    assert destination.exists() is False


def test_workbench_setup_file_force_replaces_symlink_not_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    target = tmp_path / "target.txt"
    target.write_text("preserve", encoding="utf-8")
    destination = tmp_path / "setup.log"
    destination.symlink_to(target)
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        lambda *_args, **_kwargs: response(
            200, {"content": "setup output\n", "truncated": False}
        ),
    )
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
            "--force",
        ],
    )

    assert result.exit_code == 0
    assert target.read_text() == "preserve"
    assert destination.is_symlink() is False
    assert destination.read_text() == "setup output\n"


def test_private_file_write_cleans_temporary_file_after_interrupt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    destination = tmp_path / "setup.log"

    def interrupt(_source: Path, _destination: Path) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr("harbor_hf.workbench_cli.os.replace", interrupt)
    with pytest.raises(KeyboardInterrupt):
        _write_private_text(
            destination,
            "private output",
            force=True,
            fail=lambda message, _code: (_ for _ in ()).throw(AssertionError(message)),
        )

    assert destination.exists() is False
    assert list(tmp_path.iterdir()) == []


def profile(
    profile_id: str,
    kind: str,
    alias: str,
    spec: dict[str, object],
) -> dict[str, object]:
    return {
        "profile_id": profile_id,
        "profile_kind": kind,
        "name": alias,
        "source": "repository",
        "promotion_state": "approved",
        "alias": alias,
        "approved_aliases": [alias],
        "spec": spec,
        "created_at": "2026-01-01T00:00:00Z",
    }


def publication_request(
    expected_harness: dict[str, object],
    profiles: list[dict[str, object]],
) -> Callable[..., httpx.Response]:
    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        if url.endswith("/api/v1/workbench/preview"):
            return response(
                200,
                {
                    "recipe_digest": "sha256:recipe",
                    "revision_id": "revision-one",
                    "harness_profile": expected_harness,
                },
            )
        if "/api/v1/workbench/setup-tests/" in url:
            return response(200, setup_value("passed"))
        if "/api/v1/profiles?" in url:
            return response(200, {"items": profiles, "next_cursor": None})
        raise AssertionError((method, url))

    return request


def test_workbench_publication_reports_runnable_profile(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    harness: dict[str, object] = {
        "agent": "command-agent",
        "config": {"version": 1},
    }
    profiles = [
        profile("model-one", "model", "model-alias", {"model_id": "model/id"}),
        profile("harness-one", "harness", "harness-alias", harness),
        profile(
            "deployment-one",
            "deployment",
            "deployment-alias",
            {
                "models": ["model-alias"],
                "harnesses": ["harness-alias"],
                "inference_provider": "provider",
            },
        ),
    ]
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        publication_request(harness, profiles),
    )
    result = runner.invoke(
        app,
        [
            "workbench",
            "publication",
            str(source),
            "--setup-test",
            "setup-one",
            "--require-ready",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout) == {
        "deployment": "deployment-alias",
        "deployment_kind": "providers",
        "harness": "harness-alias",
        "model": "model-alias",
        "recipe_digest": "sha256:recipe",
        "revision_id": "revision-one",
        "setup_status": "passed",
        "setup_test_id": "setup-one",
        "state": "published",
    }


def test_workbench_publication_requires_exact_tested_recipe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)

    def request(_method: str, url: str, **_kwargs: object) -> httpx.Response:
        if url.endswith("/api/v1/workbench/preview"):
            return response(
                200,
                {
                    "recipe_digest": "sha256:changed",
                    "revision_id": "revision-one",
                    "harness_profile": {},
                },
            )
        return response(200, setup_value("passed"))

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "publication",
            str(source),
            "--setup-test",
            "setup-one",
            "--require-ready",
        ],
    )

    assert result.exit_code == 1
    assert json.loads(result.stdout)["state"] == "test-required"


def test_workbench_publication_rejects_missing_identity_fields(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)

    def request(_method: str, url: str, **_kwargs: object) -> httpx.Response:
        if url.endswith("/api/v1/workbench/preview"):
            return response(200, {"harness_profile": {}})
        return response(
            200,
            {
                **setup_value("passed"),
                "recipe_digest": None,
                "revision_id": None,
            },
        )

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "publication",
            str(source),
            "--setup-test",
            "setup-one",
        ],
    )

    assert result.exit_code == 1
    assert "identity fields" in result.output


@pytest.mark.parametrize(
    ("profiles", "expected_state"),
    [
        ([], "unpublished"),
        (
            [
                profile(
                    "harness-one",
                    "harness",
                    "harness-alias",
                    {"agent": "command-agent"},
                )
            ],
            "published-no-deployment",
        ),
    ],
)
def test_workbench_publication_reports_non_runnable_states(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    profiles: list[dict[str, object]],
    expected_state: str,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    harness: dict[str, object] = {"agent": "command-agent"}
    monkeypatch.setattr(
        "harbor_hf.cli.httpx.request",
        publication_request(harness, profiles),
    )
    result = runner.invoke(
        app,
        [
            "workbench",
            "publication",
            str(source),
            "--setup-test",
            "setup-one",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["state"] == expected_state


def test_workbench_publication_follows_profile_pagination(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)
    harness: dict[str, object] = {"agent": "command-agent"}
    profile_pages = 0

    def request(_method: str, url: str, **_kwargs: object) -> httpx.Response:
        nonlocal profile_pages
        if url.endswith("/api/v1/workbench/preview"):
            return response(
                200,
                {
                    "recipe_digest": "sha256:recipe",
                    "revision_id": "revision-one",
                    "harness_profile": harness,
                },
            )
        if "/api/v1/workbench/setup-tests/" in url:
            return response(200, setup_value("passed"))
        if url.endswith("/api/v1/profiles?limit=100"):
            profile_pages += 1
            return response(
                200,
                {
                    "items": [
                        profile(
                            "model-one",
                            "model",
                            "model-alias",
                            {"model_id": "model/id"},
                        )
                    ],
                    "next_cursor": "page/two",
                },
            )
        if url.endswith("/api/v1/profiles?limit=100&cursor=page%2Ftwo"):
            profile_pages += 1
            return response(
                200,
                {
                    "items": [
                        profile(
                            "harness-one",
                            "harness",
                            "harness-alias",
                            harness,
                        ),
                        profile(
                            "deployment-one",
                            "deployment",
                            "deployment-alias",
                            {
                                "models": ["model-alias"],
                                "harnesses": ["harness-alias"],
                                "inference_provider": "provider",
                            },
                        ),
                    ],
                    "next_cursor": None,
                },
            )
        raise AssertionError(url)

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "publication",
            str(source),
            "--setup-test",
            "setup-one",
            "--require-ready",
        ],
    )

    assert result.exit_code == 0
    assert profile_pages == 2


def test_workbench_publication_rejects_repeated_profile_cursor(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure(monkeypatch)
    source = tmp_path / "recipe.json"
    write_recipe(source)

    def request(_method: str, url: str, **_kwargs: object) -> httpx.Response:
        if url.endswith("/api/v1/workbench/preview"):
            return response(
                200,
                {
                    "recipe_digest": "sha256:recipe",
                    "revision_id": "revision-one",
                    "harness_profile": {},
                },
            )
        if "/api/v1/workbench/setup-tests/" in url:
            return response(200, setup_value("passed"))
        if "/api/v1/profiles?" in url:
            return response(
                200,
                {
                    "items": [profile("model-one", "model", "model-alias", {})],
                    "next_cursor": "same",
                },
            )
        raise AssertionError(url)

    monkeypatch.setattr("harbor_hf.cli.httpx.request", request)
    result = runner.invoke(
        app,
        [
            "workbench",
            "publication",
            str(source),
            "--setup-test",
            "setup-one",
        ],
    )

    assert result.exit_code == 1
    assert "made no progress" in result.output


def test_profile_pagination_deduplicates_profile_ids() -> None:
    pages = iter(
        [
            {
                "items": [
                    profile(
                        "profile-one",
                        "model",
                        "first-alias",
                        {"model_id": "model/one"},
                    )
                ],
                "next_cursor": "next",
            },
            {
                "items": [
                    profile(
                        "profile-one",
                        "model",
                        "duplicate-alias",
                        {"model_id": "model/duplicate"},
                    ),
                    profile(
                        "profile-two",
                        "model",
                        "second-alias",
                        {"model_id": "model/two"},
                    ),
                ],
                "next_cursor": None,
            },
        ]
    )

    items = _profile_items(
        lambda *_args, **_kwargs: next(pages),
        lambda message, _code: (_ for _ in ()).throw(AssertionError(message)),
    )

    assert [item["profile_id"] for item in items] == [
        "profile-one",
        "profile-two",
    ]
    assert items[0]["approved_aliases"] == ["first-alias"]

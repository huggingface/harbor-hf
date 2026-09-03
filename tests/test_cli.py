from __future__ import annotations

import json
import runpy
from pathlib import Path
from typing import cast

import httpx
import pytest
import typer
from typer.testing import CliRunner

import harbor_hf.cli as cli
from harbor_hf.cli import app

runner = CliRunner()


def response(status: int, body: object) -> httpx.Response:
    return httpx.Response(
        status,
        json=body,
        request=httpx.Request("GET", "https://control.example"),
    )


def configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "https://control.example/")
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "test-bearer")


def test_submit_sends_direct_config_without_printing_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure(monkeypatch)
    config = tmp_path / "job.yaml"
    config.write_text("agents:\n  - name: pi\n    model_name: openai/model:provider\n")
    captured: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        captured.update(method=method, url=url, **kwargs)
        return response(201, {"created": True, "run": {"run_id": "run-example"}})

    monkeypatch.setattr(httpx, "request", request)
    result = runner.invoke(
        app,
        [
            "submit",
            "--config",
            str(config),
            "--cost-ceiling-usd-per-trial",
            "0.25",
            "--idempotency-key",
            "test-key",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.stdout)["run"]["run_id"] == "run-example"
    assert captured["method"] == "POST"
    assert captured["url"] == "https://control.example/api/v1/runs/config"
    payload = cast(dict[str, object], captured["json"])
    agents = cast(list[dict[str, object]], payload["agents"])
    headers = cast(dict[str, str], captured["headers"])
    assert agents[0]["name"] == "pi"
    assert headers["Idempotency-Key"] == "test-key"
    assert headers["X-Harbor-HF-Cost-Ceiling-USD-Per-Trial"] == "0.25"
    assert "test-bearer" not in result.output


def test_status_and_jobs_use_the_control_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    paths: list[str] = []

    def request(_method: str, url: str, **_kwargs: object) -> httpx.Response:
        paths.append(url)
        return response(200, {"ok": True})

    monkeypatch.setattr(httpx, "request", request)
    assert runner.invoke(app, ["run", "status", "run-abc"]).exit_code == 0
    assert runner.invoke(app, ["jobs"]).exit_code == 0
    assert paths == [
        "https://control.example/api/v1/runs/run-abc",
        "https://control.example/api/v1/jobs",
    ]


def test_cancel_requires_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch)
    called = False

    def request(_method: str, _url: str, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return response(200, {})

    monkeypatch.setattr(httpx, "request", request)
    rejected = runner.invoke(app, ["run", "cancel", "run-abc"], input="n\n")
    assert rejected.exit_code != 0
    assert not called
    accepted = runner.invoke(app, ["run", "cancel", "run-abc", "--yes"])
    assert accepted.exit_code == 0
    assert called


def test_invalid_config_stops_before_network(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure(monkeypatch)
    config = tmp_path / "job.yaml"
    config.write_text("- not-an-object\n")
    result = runner.invoke(
        app,
        [
            "submit",
            "--config",
            str(config),
            "--cost-ceiling-usd-per-trial",
            "1",
        ],
    )
    assert result.exit_code != 0
    assert "config must contain one object" in result.output


def test_api_and_network_errors_are_plain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(
            409, {"error": {"message": "idempotency conflict"}}
        ),
    )
    rejected = runner.invoke(app, ["jobs"])
    assert rejected.exit_code == 1
    assert "control API returned 409: idempotency conflict" in rejected.output

    def fail(*_args: object, **_kwargs: object) -> httpx.Response:
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx, "request", fail)
    unavailable = runner.invoke(app, ["jobs"])
    assert unavailable.exit_code == 1
    assert "ConnectError" in unavailable.output


def test_other_commands_and_empty_response(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch)
    calls: list[tuple[str, str]] = []

    def request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        calls.append((method, url))
        return response(204, {})

    monkeypatch.setattr(httpx, "request", request)
    for command in (
        ["run", "list"],
        ["run", "pause", "run-a"],
        ["run", "resume", "run-a"],
        ["presets"],
    ):
        assert runner.invoke(app, command).exit_code == 0
    assert [method for method, _url in calls] == ["GET", "POST", "POST", "GET"]


def test_rejects_invalid_json_and_malformed_yaml(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure(monkeypatch)
    raw = httpx.Response(
        200,
        content=b"not-json",
        request=httpx.Request("GET", "https://control.example"),
    )
    monkeypatch.setattr(httpx, "request", lambda *_args, **_kwargs: raw)
    invalid_json = runner.invoke(app, ["jobs"])
    assert invalid_json.exit_code == 1
    assert "invalid JSON" in invalid_json.output

    config = tmp_path / "job.yaml"
    config.write_text("broken: [\n")
    malformed = runner.invoke(
        app,
        [
            "submit",
            "--config",
            str(config),
            "--cost-ceiling-usd-per-trial",
            "1",
        ],
    )
    assert malformed.exit_code != 0
    assert "cannot read config" in malformed.output


def test_generated_key_is_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure(monkeypatch)
    config = tmp_path / "job.json"
    config.write_text('{"agents": [{"name": "pi"}]}')
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *_args, **_kwargs: response(201, {"created": True}),
    )
    result = runner.invoke(
        app,
        [
            "submit",
            "--config",
            str(config),
            "--cost-ceiling-usd-per-trial",
            "1",
        ],
    )
    assert result.exit_code == 0
    assert "idempotency_key" in result.output


def test_requires_a_secure_url_and_bearer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HARBOR_HF_CONTROL_URL", raising=False)
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "test-bearer")
    no_url = runner.invoke(app, ["jobs"])
    assert no_url.exit_code != 0
    assert "HARBOR_HF_CONTROL_URL" in no_url.output

    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "http://control.example")
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "test-bearer")
    insecure = runner.invoke(app, ["jobs"])
    assert insecure.exit_code != 0
    assert "must use HTTPS" in insecure.output

    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "https://control.example")
    monkeypatch.delenv("HARBOR_HF_CONTROL_BEARER_TOKEN")
    missing = runner.invoke(app, ["jobs"])
    assert missing.exit_code != 0
    assert "HARBOR_HF_CONTROL_BEARER_TOKEN" in missing.output


def test_url_and_header_helpers_enforce_the_transport_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "https://control.example///")
    monkeypatch.setenv("HARBOR_HF_CONTROL_BEARER_TOKEN", "  test-bearer  ")
    assert cli._base_url() == "https://control.example"
    assert cli._headers() == {
        "Authorization": "Bearer test-bearer",
        "Accept": "application/json",
    }
    assert cli._headers(idempotency_key="request-key") == {
        "Authorization": "Bearer test-bearer",
        "Accept": "application/json",
        "Idempotency-Key": "request-key",
    }

    monkeypatch.setenv("HARBOR_HF_CONTROL_URL", "http://127.0.0.1:7860/")
    assert cli._base_url() == "http://127.0.0.1:7860"
    for invalid in (
        "http://control.example",
        "http://127.0.0.1.example",
        "ftp://control.example",
        "https://",
        "not a URL",
    ):
        monkeypatch.setenv("HARBOR_HF_CONTROL_URL", invalid)
        with pytest.raises(typer.BadParameter):
            cli._base_url()

    monkeypatch.delenv("HARBOR_HF_CONTROL_URL")
    with pytest.raises(typer.BadParameter, match="set HARBOR_HF_CONTROL_URL"):
        cli._base_url()
    monkeypatch.delenv("HARBOR_HF_CONTROL_BEARER_TOKEN")
    with pytest.raises(typer.BadParameter, match="set HARBOR_HF_CONTROL_BEARER_TOKEN"):
        cli._headers()


def test_request_helper_sets_exact_http_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch)
    captured: dict[str, object] = {}

    def request(method: str, url: str, **kwargs: object) -> httpx.Response:
        captured.update(method=method, url=url, **kwargs)
        return response(200, {"result": "ok"})

    monkeypatch.setattr(httpx, "request", request)
    result = cli._request(
        "PATCH",
        "/api/v1/example",
        payload={"value": 1},
        idempotency_key="request-key",
        extra_headers={"X-Extra": "value"},
    )

    assert result == {"result": "ok"}
    assert captured == {
        "method": "PATCH",
        "url": "https://control.example/api/v1/example",
        "headers": {
            "Authorization": "Bearer test-bearer",
            "Accept": "application/json",
            "Idempotency-Key": "request-key",
            "X-Extra": "value",
        },
        "json": {"value": 1},
        "timeout": 30,
        "follow_redirects": False,
    }


def test_request_helper_handles_status_edges_and_invalid_bodies(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    configure(monkeypatch)
    replies = iter(
        (
            response(400, {}),
            httpx.Response(
                204,
                content=b"not-json",
                request=httpx.Request("GET", "https://control.example"),
            ),
            httpx.Response(
                205,
                content=b"not-json",
                request=httpx.Request("GET", "https://control.example"),
            ),
        )
    )
    monkeypatch.setattr(httpx, "request", lambda *_args, **_kwargs: next(replies))

    with pytest.raises(typer.Exit) as rejected:
        cli._request("GET", "/rejected")
    assert rejected.value.exit_code == 1
    assert capsys.readouterr().err == (
        '{"error": "control API returned 400: request rejected"}\n'
    )
    assert cli._request("GET", "/empty") == {}
    assert capsys.readouterr().err == ""
    with pytest.raises(typer.Exit) as invalid:
        cli._request("GET", "/invalid")
    assert invalid.value.exit_code == 1
    assert capsys.readouterr().err == (
        '{"error": "control API returned invalid JSON"}\n'
    )


def test_output_config_and_action_helpers_are_exact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli._echo({"z": 1, "a": 2})
    assert capsys.readouterr().out == '{\n  "a": 2,\n  "z": 1\n}\n'

    with pytest.raises(typer.Exit) as failed:
        cli._fail("broken")
    streams = capsys.readouterr()
    assert streams.out == ""
    assert streams.err == '{"error": "broken"}\n'
    assert failed.value.exit_code == 1

    config = tmp_path / "job.yaml"
    config.write_text("name: café\n", encoding="utf-8")
    assert cli._load_config(config) == {"name": "café"}
    with pytest.raises(
        typer.BadParameter, match="cannot read config: FileNotFoundError"
    ):
        cli._load_config(tmp_path / "missing.yaml")
    list_config = tmp_path / "list.yaml"
    list_config.write_text("- not-an-object\n", encoding="utf-8")
    with pytest.raises(typer.BadParameter, match="config must contain one object"):
        cli._load_config(list_config)

    calls: list[tuple[str, str]] = []
    values: list[object] = []

    def request_action(method: str, path: str, **_kwargs: object) -> object:
        calls.append((method, path))
        return {"state": "pausing"}

    monkeypatch.setattr(cli, "_request", request_action)
    monkeypatch.setattr(cli, "_echo", values.append)
    cli._run_action("run-123", "pause")
    assert calls == [("POST", "/api/v1/runs/run-123/pause")]
    assert values == [{"state": "pausing"}]


def test_module_entry_point_calls_the_app(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    def invoke() -> None:
        nonlocal called
        called = True

    monkeypatch.setattr("harbor_hf.cli.app", invoke)
    runpy.run_module("harbor_hf.__main__", run_name="__main__")
    assert called

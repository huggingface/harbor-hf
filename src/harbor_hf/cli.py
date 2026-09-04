from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, NoReturn
from uuid import uuid4

import httpx
import typer
import yaml

app = typer.Typer(no_args_is_help=True, help="Operate the Harbor-HF control service.")
run_app = typer.Typer(no_args_is_help=True, help="Inspect and control runs.")
app.add_typer(run_app, name="run")


def _base_url() -> str:
    value = os.environ.get("HARBOR_HF_CONTROL_URL", "").rstrip("/")
    if not value:
        raise typer.BadParameter("set HARBOR_HF_CONTROL_URL")
    try:
        url = httpx.URL(value)
    except httpx.InvalidURL as error:
        raise typer.BadParameter("the control URL must be valid") from error
    is_local = url.scheme == "http" and url.host == "127.0.0.1"
    if not url.host or (url.scheme != "https" and not is_local):
        raise typer.BadParameter("the control URL must use HTTPS")
    return value


def _headers(*, idempotency_key: str | None = None) -> dict[str, str]:
    token = os.environ.get("HARBOR_HF_CONTROL_BEARER_TOKEN", "").strip()
    if not token:
        raise typer.BadParameter("set HARBOR_HF_CONTROL_BEARER_TOKEN")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return headers


def _fail(message: str) -> NoReturn:
    typer.echo(json.dumps({"error": message}), err=True)
    raise typer.Exit(1)


def _request(
    method: str,
    path: str,
    *,
    payload: object | None = None,
    idempotency_key: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> object:
    headers = _headers(idempotency_key=idempotency_key)
    headers.update(extra_headers or {})
    try:
        response = httpx.request(
            method,
            f"{_base_url()}{path}",
            headers=headers,
            json=payload,
            timeout=30,
            follow_redirects=False,
        )
    except httpx.HTTPError as error:
        _fail(f"control API request failed: {type(error).__name__}")
    if response.status_code >= 400:
        try:
            body = response.json()
            detail = body["error"]["message"]
        except (KeyError, TypeError, ValueError):
            detail = "request rejected"
        _fail(f"control API returned {response.status_code}: {detail}")
    if response.status_code == 204:
        return {}
    try:
        return response.json()
    except ValueError:
        _fail("control API returned invalid JSON")


def _echo(value: object) -> None:
    typer.echo(json.dumps(value, indent=2, sort_keys=True))


def _load_config(path: Path) -> dict[str, object]:
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        message = f"cannot read config: {type(error).__name__}"
        raise typer.BadParameter(message) from error
    if not isinstance(value, dict):
        raise typer.BadParameter("config must contain one object")
    return value


@app.command("submit")
def submit(
    config: Annotated[Path, typer.Option("--config", exists=True, dir_okay=False)],
    cost_ceiling_usd_per_trial: Annotated[
        float,
        typer.Option("--cost-ceiling-usd-per-trial", min=0.000001, max=10_000),
    ],
    idempotency_key: Annotated[str | None, typer.Option("--idempotency-key")] = None,
) -> None:
    """Submit one validated Harbor JobConfig."""
    key = idempotency_key or str(uuid4())
    if not idempotency_key:
        typer.echo(json.dumps({"idempotency_key": key}), err=True)
    _echo(
        _request(
            "POST",
            "/api/v1/runs/config",
            payload=_load_config(config),
            idempotency_key=key,
            extra_headers={
                "X-Harbor-HF-Cost-Ceiling-USD-Per-Trial": str(
                    cost_ceiling_usd_per_trial
                )
            },
        )
    )


@run_app.command("list")
def run_list() -> None:
    """List runs."""
    _echo(_request("GET", "/api/v1/runs"))


@run_app.command("status")
def run_status(run_id: str) -> None:
    """Read one run."""
    _echo(_request("GET", f"/api/v1/runs/{run_id}"))


def _run_action(run_id: str, action: str) -> None:
    _echo(_request("POST", f"/api/v1/runs/{run_id}/{action}"))


@run_app.command("pause")
def run_pause(run_id: str) -> None:
    """Pause one run at a safe Harbor resume boundary."""
    _run_action(run_id, "pause")


@run_app.command("resume")
def run_resume(run_id: str) -> None:
    """Resume one paused run."""
    _run_action(run_id, "resume")


@run_app.command("cancel")
def run_cancel(
    run_id: str,
    yes: Annotated[
        bool,
        typer.Option("--yes", help="Confirm permanent cancellation."),
    ] = False,
) -> None:
    """Permanently cancel one run."""
    if not yes:
        typer.confirm(f"Permanently cancel {run_id}?", abort=True)
    _run_action(run_id, "cancel")


@app.command("jobs")
def jobs() -> None:
    """List owned parent Jobs."""
    _echo(_request("GET", "/api/v1/jobs"))


@app.command("presets")
def presets() -> None:
    """List reviewed benchmark and agent presets."""
    _echo(_request("GET", "/api/v1/presets"))

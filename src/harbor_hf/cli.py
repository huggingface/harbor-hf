from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, NoReturn
from uuid import uuid4

import httpx
import typer
import yaml

from harbor_hf.workbench_cli import (
    TransientControlError,
    read_workbench_recipe,
    register_workbench_commands,
)

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


def _fail(message: str, exit_code: int = 1) -> NoReturn:
    typer.echo(json.dumps({"error": message}), err=True)
    raise typer.Exit(exit_code)


def _request(
    method: str,
    path: str,
    *,
    payload: object | None = None,
    idempotency_key: str | None = None,
    timeout_seconds: float = 30.0,
    transient: bool = False,
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
            timeout=timeout_seconds,
            follow_redirects=False,
        )
    except httpx.HTTPError as error:
        if transient:
            raise TransientControlError from error
        _fail(f"control API request failed: {type(error).__name__}")
    if transient and response.status_code in {408, 425, 429, 500, 502, 503, 504}:
        raise TransientControlError
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


@run_app.command("submit")
def run_submit(  # noqa: C901 -- Keep one Typer command as one validation boundary.
    benchmark: Annotated[str, typer.Option("--benchmark")],
    preset: Annotated[str, typer.Option("--preset")],
    model: Annotated[str, typer.Option("--model")],
    provider: Annotated[str, typer.Option("--provider")],
    cost_ceiling_usd_per_trial: Annotated[
        float,
        typer.Option("--cost-ceiling-usd-per-trial", min=0.000001, max=10_000),
    ],
    agent: Annotated[str | None, typer.Option("--agent")] = None,
    agent_version: Annotated[str | None, typer.Option("--agent-version")] = None,
    reasoning_effort: Annotated[str, typer.Option("--reasoning-effort")] = "off",
    role: Annotated[str, typer.Option("--role")] = "diagnostic",
    harness: Annotated[
        Path | None,
        typer.Option("--harness", exists=True, dir_okay=False),
    ] = None,
    setup_test: Annotated[str | None, typer.Option("--setup-test")] = None,
    idempotency_key: Annotated[str | None, typer.Option("--idempotency-key")] = None,
    yes: Annotated[bool, typer.Option("--yes")] = False,
) -> None:
    """Submit one reviewed preset or exact tested Workbench recipe."""
    if role not in {"final", "diagnostic"}:
        raise typer.BadParameter("role must be final or diagnostic")
    workbench = harness is not None or setup_test is not None
    if workbench and (harness is None or setup_test is None):
        raise typer.BadParameter("--harness and --setup-test must be used together")
    if workbench and (agent is not None or agent_version is not None):
        raise typer.BadParameter(
            "Workbench submission does not use agent preset options"
        )
    if not workbench and (agent is None or agent_version is None):
        raise typer.BadParameter(
            "preset submission requires --agent and --agent-version"
        )
    if workbench and reasoning_effort != "off":
        raise typer.BadParameter("Workbench submission requires reasoning effort off")
    if not yes:
        typer.confirm(
            "Submit this Harbor run with the displayed per-trial cost ceiling?",
            abort=True,
        )
    key = idempotency_key or str(uuid4())
    if not 1 <= len(key) <= 256:
        raise typer.BadParameter("idempotency key must contain 1 to 256 characters")
    if idempotency_key is None:
        typer.echo(json.dumps({"idempotency_key": key}), err=True)
    payload: dict[str, object] = {
        "benchmark": {"name": benchmark, "preset": preset},
        "model": {
            "id": model,
            "provider": provider,
            "reasoning_effort": reasoning_effort,
        },
        "cost_ceiling_usd_per_trial": cost_ceiling_usd_per_trial,
        "role": role,
    }
    if workbench:
        assert harness is not None and setup_test is not None
        payload["workbench"] = {
            "recipe": read_workbench_recipe(str(harness), _fail),
            "setup_test_id": setup_test,
        }
    else:
        payload["harness"] = {"agent": agent, "version": agent_version}
    _echo(
        _request(
            "POST",
            "/api/v1/runs",
            payload=payload,
            idempotency_key=key,
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


register_workbench_commands(app, request=_request, echo=_echo, fail=_fail)

from __future__ import annotations

import json
import os
from typing import Annotated, NoReturn
from uuid import uuid4

import httpx
import typer
from huggingface_hub import get_token

app = typer.Typer(
    no_args_is_help=True,
    help="Operate Harbor-HF through the TypeScript control service.",
)
campaign_app = typer.Typer(no_args_is_help=True, help="Submit and inspect campaigns.")
app.add_typer(campaign_app, name="campaign")


def _base_url() -> str:
    value = os.environ.get("HARBOR_HF_CONTROL_URL", "").rstrip("/")
    if not value:
        raise typer.BadParameter(
            "set HARBOR_HF_CONTROL_URL to the private control Space URL"
        )
    if not value.startswith("https://") and not value.startswith("http://127.0.0.1"):
        raise typer.BadParameter("the control URL must use HTTPS")
    return value


def _headers(*, idempotency_key: str | None = None) -> dict[str, str]:
    token = get_token()
    if not token:
        raise typer.BadParameter(
            "log in with the Hugging Face CLI before using the control API"
        )
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return headers


def _fail(message: str, code: int = 1) -> NoReturn:
    typer.echo(json.dumps({"error": message}, sort_keys=True), err=True)
    raise typer.Exit(code)


def _request(
    method: str,
    path: str,
    *,
    payload: dict[str, object] | None = None,
    idempotency_key: str | None = None,
) -> object:
    try:
        response = httpx.request(
            method,
            f"{_base_url()}{path}",
            headers=_headers(idempotency_key=idempotency_key),
            json=payload,
            timeout=30,
            follow_redirects=False,
        )
    except (httpx.HTTPError, ValueError) as error:
        _fail(f"control API request failed: {type(error).__name__}")
    if response.status_code >= 400:
        try:
            body = response.json()
            message = body.get("error", {}).get("message", "request rejected")
        except (TypeError, ValueError):
            message = "request rejected"
        _fail(f"control API returned {response.status_code}: {message}")
    if response.status_code == 204:
        return {}
    return response.json()


def _echo(value: object) -> None:
    typer.echo(json.dumps(value, indent=2, sort_keys=True))


@app.command("status")
def status() -> None:
    """Show control-service readiness and write mode."""
    _echo(_request("GET", "/api/v1/system"))


@campaign_app.command("list")
def campaign_list() -> None:
    """List campaigns from the control service."""
    _echo(_request("GET", "/api/v1/campaigns"))


@campaign_app.command("status")
def campaign_status(campaign_id: Annotated[str, typer.Argument()]) -> None:
    """Show one campaign."""
    _echo(_request("GET", f"/api/v1/campaigns/{campaign_id}"))


@campaign_app.command("submit")
def campaign_submit(
    benchmark: Annotated[str, typer.Option("--benchmark")],
    model: Annotated[str, typer.Option("--model")],
    harness: Annotated[str, typer.Option("--harness")],
    ceiling_microusd: Annotated[int, typer.Option("--ceiling-microusd", min=0)],
    deployment: Annotated[str | None, typer.Option("--deployment")] = None,
    launch_policy: Annotated[str, typer.Option("--launch-policy")] = "default",
    idempotency_key: Annotated[str | None, typer.Option("--idempotency-key")] = None,
    yes: Annotated[
        bool,
        typer.Option("--yes", help="Confirm the resolved launch and cost ceiling."),
    ] = False,
) -> None:
    """Submit profile references and return the durable campaign ID."""
    if not yes:
        typer.confirm(
            f"Launch {benchmark} with {model} through {harness}, "
            f"with a ceiling of {ceiling_microusd} micro-USD?",
            abort=True,
        )
    key = idempotency_key or str(uuid4())
    if not idempotency_key:
        typer.echo(json.dumps({"idempotency_key": key}), err=True)
    payload: dict[str, object] = {
        "benchmark": benchmark,
        "model": model,
        "harness": harness,
        "deployment": deployment,
        "launch_policy": launch_policy,
        "ceiling_microusd": ceiling_microusd,
        "confirmed": True,
    }
    _echo(_request("POST", "/api/v1/campaigns", payload=payload, idempotency_key=key))


def _campaign_action(
    campaign_id: str,
    action: str,
    *,
    task_id: str | None = None,
    reason: str | None = None,
    yes: bool,
) -> None:
    if not yes:
        typer.confirm(f"Apply {action} to {campaign_id}?", abort=True)
    key = str(uuid4())
    typer.echo(json.dumps({"idempotency_key": key}), err=True)
    _echo(
        _request(
            "POST",
            f"/api/v1/campaigns/{campaign_id}/actions",
            payload={
                "action": action,
                "task_id": task_id,
                "reason": reason,
                "confirmed": True,
            },
            idempotency_key=key,
        )
    )


@campaign_app.command("cancel")
def campaign_cancel(
    campaign_id: Annotated[str, typer.Argument()],
    reason: Annotated[str | None, typer.Option("--reason")] = None,
    yes: Annotated[bool, typer.Option("--yes")] = False,
) -> None:
    """Cancel open logical tasks without deleting evidence."""
    _campaign_action(campaign_id, "cancel", reason=reason, yes=yes)


@campaign_app.command("retry-infrastructure")
def campaign_retry_infrastructure(
    campaign_id: Annotated[str, typer.Argument()],
    task_id: Annotated[str, typer.Option("--task")],
    reason: Annotated[str | None, typer.Option("--reason")] = None,
    yes: Annotated[bool, typer.Option("--yes")] = False,
) -> None:
    """Request a bounded infrastructure-only replacement."""
    _campaign_action(
        campaign_id,
        "retry_infrastructure",
        task_id=task_id,
        reason=reason,
        yes=yes,
    )


@campaign_app.command("pause-endpoint")
def campaign_pause_endpoint(
    campaign_id: Annotated[str, typer.Argument()],
    reason: Annotated[str | None, typer.Option("--reason")] = None,
    yes: Annotated[bool, typer.Option("--yes")] = False,
) -> None:
    """Pause the campaign's one active managed endpoint."""
    _campaign_action(
        campaign_id,
        "pause_endpoint",
        reason=reason,
        yes=yes,
    )


@app.command("jobs")
def jobs() -> None:
    """List projected HF Job actions."""
    _echo(_request("GET", "/api/v1/jobs"))


@app.command("endpoints")
def endpoints() -> None:
    """List managed endpoint state and cleanup status."""
    _echo(_request("GET", "/api/v1/endpoints"))


@app.command("profiles")
def profiles() -> None:
    """List resolved immutable profiles."""
    _echo(_request("GET", "/api/v1/profiles"))


@app.command("results")
def results() -> None:
    """List immutable result publications."""
    _echo(_request("GET", "/api/v1/results"))


@app.command("audit")
def audit() -> None:
    """List recent immutable control records."""
    _echo(_request("GET", "/api/v1/audit"))


if __name__ == "__main__":
    app()

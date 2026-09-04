from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path
from typing import Annotated, NoReturn, Protocol, cast
from urllib.parse import quote
from uuid import uuid4

import typer

_MAX_RECIPE_BYTES = 1024 * 1024
_ACTIVE_SETUP_STATUSES = {"queued", "running", "cancelling"}
_TERMINAL_SETUP_STATUSES = {"cancelled", "passed", "failed", "timed-out"}


class Request(Protocol):
    def __call__(
        self,
        method: str,
        path: str,
        *,
        payload: object | None = None,
        idempotency_key: str | None = None,
        timeout_seconds: float = 30.0,
        transient: bool = False,
        extra_headers: dict[str, str] | None = None,
    ) -> object: ...


Echo = Callable[[object], None]
Fail = Callable[[str, int], NoReturn]


class TransientControlError(Exception):
    """One retryable control-service polling failure."""


class LogChannel(StrEnum):
    JSON = "json"
    STDOUT = "stdout"
    STDERR = "stderr"
    COMBINED = "combined"


def read_workbench_recipe(source: str, fail: Fail) -> dict[str, object]:
    try:
        payload = (
            sys.stdin.buffer.read(_MAX_RECIPE_BYTES + 1)
            if source == "-"
            else Path(source).read_bytes()
        )
    except OSError:
        fail("recipe file could not be read", 1)
    if len(payload) > _MAX_RECIPE_BYTES:
        fail("recipe input exceeds the 1 MiB limit", 1)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        fail("recipe input must be UTF-8 JSON", 1)
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        fail("recipe input must contain valid JSON", 1)
    if not isinstance(value, dict):
        fail("recipe JSON root must be an object", 1)
    return cast(dict[str, object], value)


def _idempotency_key(value: str | None, fail: Fail) -> str:
    key = value or str(uuid4())
    if not 8 <= len(key) <= 256:
        fail("idempotency key must contain 8 to 256 characters", 1)
    if value is None:
        typer.echo(json.dumps({"idempotency_key": key}), err=True)
    return key


def _setup_path(setup_test_id: str) -> str:
    return f"/api/v1/workbench/setup-tests/{quote(setup_test_id, safe='')}"


def _file_path(setup_test_id: str, file_id: str) -> str:
    return f"{_setup_path(setup_test_id)}/files/{quote(file_id, safe='')}"


def _setup_status(value: object, fail: Fail) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("status"), str):
        fail("control API returned an invalid setup response", 1)
    record = cast(dict[str, object], value)
    status = cast(str, record["status"])
    if status not in _ACTIVE_SETUP_STATUSES | _TERMINAL_SETUP_STATUSES:
        fail("control API returned an unknown setup status", 1)
    return status


def _remaining_seconds(deadline: float, fail: Fail) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        fail("setup wait timed out without cancelling the setup test", 1)
    return remaining


def _wait_for_setup(
    setup_test_id: str,
    *,
    request: Request,
    echo: Echo,
    fail: Fail,
    poll_interval: float,
    timeout_seconds: float,
    success_statuses: set[str],
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        remaining = _remaining_seconds(deadline, fail)
        try:
            value = request(
                "GET",
                _setup_path(setup_test_id),
                timeout_seconds=min(30.0, remaining),
                transient=True,
            )
        except TransientControlError:
            time.sleep(min(poll_interval, _remaining_seconds(deadline, fail)))
            continue
        status = _setup_status(value, fail)
        if status in _TERMINAL_SETUP_STATUSES:
            echo(value)
            if status not in success_statuses:
                raise typer.Exit(1)
            return
        time.sleep(min(poll_interval, _remaining_seconds(deadline, fail)))


def _write_private_text(
    destination: Path,
    content: str,
    *,
    force: bool,
    fail: Fail,
) -> None:
    temporary = destination.with_name(
        f".{destination.name}.{uuid4().hex}.harbor-hf-tmp"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        try:
            descriptor = os.open(temporary, flags, 0o600)
        except OSError:
            fail("output file could not be opened", 1)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                descriptor = -1
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        except (OSError, UnicodeError):
            fail("output file could not be written", 1)
        try:
            if force:
                os.replace(temporary, destination)
            else:
                os.link(temporary, destination, follow_symlinks=False)
        except FileExistsError:
            fail("output file already exists; use --force to replace it", 1)
        except OSError:
            fail("output file could not be installed", 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _setup_collection(value: object, fail: Fail) -> list[object]:
    if not isinstance(value, dict) or not isinstance(value.get("setups"), list):
        fail("control API returned an invalid setup collection", 1)
    record = cast(dict[str, object], value)
    return cast(list[object], record["setups"])


def register_workbench_commands(  # noqa: C901 -- Keep related Typer commands in one registrar.
    root: typer.Typer,
    *,
    request: Request,
    echo: Echo,
    fail: Fail,
) -> None:
    workbench = typer.Typer(
        no_args_is_help=True,
        help="Preview and privately test generic command-agent recipes.",
    )
    setup = typer.Typer(no_args_is_help=True, help="Manage disposable setup tests.")
    workbench.add_typer(setup, name="setup")
    root.add_typer(workbench, name="workbench")

    @workbench.command("preview")
    def preview(recipe: Annotated[str, typer.Argument(help="JSON file or -")]) -> None:
        """Compile one recipe without starting a Job."""
        echo(
            request(
                "POST",
                "/api/v1/workbench/preview",
                payload=read_workbench_recipe(recipe, fail),
            )
        )

    @setup.command("start")
    def setup_start(
        recipe: Annotated[str, typer.Argument(help="JSON file or -")],
        idempotency_key: Annotated[
            str | None, typer.Option("--idempotency-key")
        ] = None,
        wait: Annotated[bool, typer.Option("--wait")] = False,
        poll_interval: Annotated[
            float, typer.Option("--poll-interval", min=0.2, max=60.0)
        ] = 1.0,
        timeout_seconds: Annotated[
            float, typer.Option("--timeout-seconds", min=1.0)
        ] = 3900.0,
        yes: Annotated[bool, typer.Option("--yes")] = False,
    ) -> None:
        """Start one confirmed credentialless setup test."""
        if recipe == "-" and not yes:
            fail("use --yes when reading a recipe from stdin", 1)
        value = read_workbench_recipe(recipe, fail)
        if not yes:
            typer.confirm(
                "Launch this exact setup recipe in a disposable CPU environment?",
                abort=True,
            )
        result = request(
            "POST",
            "/api/v1/workbench/setup-tests",
            payload={"recipe": value},
            idempotency_key=_idempotency_key(idempotency_key, fail),
        )
        if not wait:
            echo(result)
            return
        if not isinstance(result, dict) or not isinstance(
            result.get("setup_test_id"), str
        ):
            fail("control API returned an invalid setup response", 1)
        result_record = cast(dict[str, object], result)
        _wait_for_setup(
            cast(str, result_record["setup_test_id"]),
            request=request,
            echo=echo,
            fail=fail,
            poll_interval=poll_interval,
            timeout_seconds=timeout_seconds,
            success_statuses={"passed"},
        )

    @setup.command("list")
    def setup_list() -> None:
        """List the current actor's recent setup tests."""
        echo(
            _setup_collection(
                request("GET", "/api/v1/workbench/setup-tests"),
                fail,
            )
        )

    @setup.command("status")
    def setup_status(setup_test_id: Annotated[str, typer.Argument()]) -> None:
        """Show one setup test."""
        echo(request("GET", _setup_path(setup_test_id)))

    @setup.command("wait")
    def setup_wait(
        setup_test_id: Annotated[str, typer.Argument()],
        poll_interval: Annotated[
            float, typer.Option("--poll-interval", min=0.2, max=60.0)
        ] = 1.0,
        timeout_seconds: Annotated[
            float, typer.Option("--timeout-seconds", min=1.0)
        ] = 3900.0,
    ) -> None:
        """Wait for a setup test and fail unless it passes."""
        _wait_for_setup(
            setup_test_id,
            request=request,
            echo=echo,
            fail=fail,
            poll_interval=poll_interval,
            timeout_seconds=timeout_seconds,
            success_statuses={"passed"},
        )

    @setup.command("cancel")
    def setup_cancel(
        setup_test_id: Annotated[str, typer.Argument()],
        wait: Annotated[bool, typer.Option("--wait")] = False,
        poll_interval: Annotated[
            float, typer.Option("--poll-interval", min=0.2, max=60.0)
        ] = 1.0,
        timeout_seconds: Annotated[
            float, typer.Option("--timeout-seconds", min=1.0)
        ] = 120.0,
        yes: Annotated[bool, typer.Option("--yes")] = False,
    ) -> None:
        """Cancel one setup test without deleting its evidence."""
        if not yes:
            typer.confirm(f"Cancel setup test {setup_test_id}?", abort=True)
        result = request("POST", f"{_setup_path(setup_test_id)}/cancel")
        if not wait or _setup_status(result, fail) == "cancelled":
            echo(result)
            return
        _wait_for_setup(
            setup_test_id,
            request=request,
            echo=echo,
            fail=fail,
            poll_interval=poll_interval,
            timeout_seconds=timeout_seconds,
            success_statuses={"cancelled"},
        )

    @setup.command("logs")
    def setup_logs(
        setup_test_id: Annotated[str, typer.Argument()],
        channel: Annotated[
            LogChannel,
            typer.Option("--channel", help="Output format or log channel."),
        ] = LogChannel.JSON,
    ) -> None:
        """Show bounded setup stdout and stderr."""
        value = request("GET", f"{_setup_path(setup_test_id)}/logs")
        if channel is LogChannel.JSON:
            echo(value)
            return
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("stdout"), str)
            or not isinstance(value.get("stderr"), str)
        ):
            fail("control API returned invalid setup logs", 1)
        logs = cast(dict[str, object], value)
        stdout = cast(str, logs["stdout"])
        stderr = cast(str, logs["stderr"])
        text = (
            stdout
            if channel is LogChannel.STDOUT
            else stderr
            if channel is LogChannel.STDERR
            else f"{stdout}{chr(10) + '[stderr]' + chr(10) if stderr else ''}{stderr}"
        )
        sys.stdout.write(text)
        sys.stdout.flush()

    @setup.command("files")
    def setup_files(setup_test_id: Annotated[str, typer.Argument()]) -> None:
        """List files retained for one setup test."""
        value = request("GET", _setup_path(setup_test_id))
        if not isinstance(value, dict) or not isinstance(value.get("files"), list):
            fail("control API returned an invalid setup file list", 1)
        setup_record = cast(dict[str, object], value)
        echo(setup_record["files"])

    @setup.command("file")
    def setup_file(
        setup_test_id: Annotated[str, typer.Argument()],
        file_id: Annotated[str, typer.Argument()],
        output: Annotated[Path | None, typer.Option("--output")] = None,
        allow_truncated: Annotated[bool, typer.Option("--allow-truncated")] = False,
        force: Annotated[bool, typer.Option("--force")] = False,
    ) -> None:
        """Show or save one bounded text-file preview."""
        value = request("GET", _file_path(setup_test_id, file_id))
        if output is None:
            echo(value)
            return
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("content"), str)
            or not isinstance(value.get("truncated"), bool)
        ):
            fail("control API returned invalid setup file content", 1)
        file_record = cast(dict[str, object], value)
        content = cast(str, file_record["content"])
        truncated = cast(bool, file_record["truncated"])
        if truncated and not allow_truncated:
            fail("file preview is truncated; use --allow-truncated to save it", 1)
        _write_private_text(output, content, force=force, fail=fail)
        echo({"output": str(output), "truncated": truncated})

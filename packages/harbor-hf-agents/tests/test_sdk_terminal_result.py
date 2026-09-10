"""Offline SDK regression adapted from huggingface_hub PR #4851.

Exercise the installed wheel, never Harbor internals or a runtime monkeypatch.
"""

import json
from importlib.metadata import version
from unittest.mock import MagicMock

import httpx
import pytest
from huggingface_hub import Sandbox
from huggingface_hub._sandbox import _SandboxServer
from huggingface_hub.errors import SandboxCommandError, SandboxError


def _make_sandbox(base_url):
    server = _SandboxServer(
        job_id="synthetic-job",
        owner="example",
        image="python:3.12",
        base_url=base_url,
        nonce="synthetic-nonce",
        sandbox_token="synthetic-token",
        api=MagicMock(token="synthetic-token"),
        capacity=0,
    )
    return Sandbox(
        id="synthetic-job",
        server=server,
        local_id=None,
        owns_sandbox=True,
        owns_server=True,
    )


def test_installed_sdk_version():
    import huggingface_hub

    expected = "1.28.0+terminal.f1c01f0.jobname.3493b0d"
    assert version("huggingface-hub") == huggingface_hub.__version__ == expected


class _TerminalStream(httpx.SyncByteStream):
    """Offline response body with an optional transport failure after its chunks."""

    def __init__(self, chunks, error=None):
        self.chunks = chunks
        self.error = error
        self.closed = False
        self.reached_tail = False

    def __iter__(self):
        yield from self.chunks
        self.reached_tail = True
        if self.error is not None:
            raise self.error

    def close(self):
        self.closed = True


@pytest.fixture
def terminal_stream(monkeypatch):
    sandbox = _make_sandbox("https://sandbox.example")
    sandbox._server._client.close()

    def setup(chunks, error=None):
        stream = _TerminalStream(chunks, error)
        response = httpx.Response(200, stream=stream)
        handler = MagicMock(return_value=response)
        client = httpx.Client(transport=httpx.MockTransport(handler))
        monkeypatch.setattr(sandbox._server, "_client", client)
        return sandbox, stream, response, handler

    yield setup
    sandbox._server.close()


@pytest.mark.parametrize(
    "exit_code,timed_out", [(0, False), (3, False), (0, True), (None, True)]
)
@pytest.mark.parametrize("check", [True, False])
@pytest.mark.parametrize("split", [True, False])
@pytest.mark.parametrize(
    "tail_error", [None, httpx.RemoteProtocolError("incomplete chunked read")]
)
def test_terminal_stream_result(
    terminal_stream, exit_code, timed_out, check, split, tail_error
):
    events = [
        {"event": "stdout", "data": "out"},
        {"event": "ping"},
        {"event": "stderr", "data": "err"},
        {
            "event": "exit",
            "exit_code": exit_code,
            "timed_out": timed_out,
            "signal": 15,
            "duration_ms": 5,
        },
    ]
    body = b"\n" + b"".join((json.dumps(event) + "\n").encode() for event in events)
    chunks = [body[i : i + 1] for i in range(len(body))] if split else [body]
    sandbox, stream, response, handler = terminal_stream(chunks, tail_error)
    on_stdout, on_stderr = MagicMock(), MagicMock()
    if check and (exit_code != 0 or timed_out):
        with pytest.raises(SandboxCommandError) as exc:
            sandbox.run(
                "example", check=check, on_stdout=on_stdout, on_stderr=on_stderr
            )
        result = exc.value.result
    else:
        result = sandbox.run(
            "example", check=check, on_stdout=on_stdout, on_stderr=on_stderr
        )
    assert (result.exit_code, result.timed_out, result.signal, result.duration_ms) == (
        exit_code,
        timed_out,
        15,
        5,
    )
    assert (result.stdout, result.stderr) == ("out", "err")
    on_stdout.assert_called_once_with("out")
    on_stderr.assert_called_once_with("err")
    assert response.is_closed and stream.closed
    assert not stream.reached_tail
    handler.assert_called_once()
    assert handler.call_args.args[0].method == "POST"


@pytest.mark.parametrize(
    "body,error,expected",
    [
        (b'{"event":"stdout","data":"partial"}\n', None, SandboxError),
        (
            b'{"event":"stdout","data":"partial"}\n',
            httpx.RemoteProtocolError("truncated"),
            httpx.RemoteProtocolError,
        ),
        (b'{"event":"exit",', None, json.JSONDecodeError),
        (
            b'{"event":"exit",',
            httpx.RemoteProtocolError("truncated"),
            httpx.RemoteProtocolError,
        ),
        (b"{invalid}\n", None, json.JSONDecodeError),
        (b'{"event":"exit"}\n', None, KeyError),
    ],
)
def test_terminal_stream_failure_before_result(terminal_stream, body, error, expected):
    sandbox, stream, response, handler = terminal_stream([body], error)
    with pytest.raises(expected):
        sandbox.run("example")
    assert response.is_closed and stream.closed
    handler.assert_called_once()


def test_terminal_stream_ignores_events_after_exit(terminal_stream):
    sandbox, stream, response, handler = terminal_stream(
        [
            b'{"event":"exit","exit_code":0}\n{"event":"stdout","data":"late"}\n{invalid}\n'
        ]
    )
    callback = MagicMock()
    assert sandbox.run("example", on_stdout=callback).stdout == ""
    callback.assert_not_called()
    assert response.is_closed and stream.closed
    handler.assert_called_once()

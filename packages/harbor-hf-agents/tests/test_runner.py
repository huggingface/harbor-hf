import base64
import json
import os
import signal
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from harbor_hf_agents import runner


@pytest.fixture
def configured(tmp_path, monkeypatch):
    for name, value in {
        "HARBOR_HF_USER_TOKEN": "test-user-credential",
        "HARBOR_HF_OWNER": "example-org",
        "HARBOR_HF_RESULTS_BUCKET": "private-results",
        "HARBOR_HF_RUN_ID": "example-run",
        "HARBOR_HF_RUNTIME_SECONDS": "60",
        "HF_TOKEN": "must-not-forward-control-credential",
        "UNRELATED_SECRET": "must-not-forward",
    }.items():
        monkeypatch.setenv(name, value)
    api = Mock()
    api.whoami.return_value = {"name": "example-org"}
    api.bucket_info.return_value = SimpleNamespace(private=True)
    monkeypatch.setattr(runner, "HfApi", Mock(return_value=api))
    config = tmp_path / "config.json"
    config.write_text(json.dumps({}))
    return config, tmp_path / "run", api


@pytest.mark.parametrize("exit_code", [0, 1, 124])
def test_native_execution_and_failure_upload(configured, monkeypatch, exit_code):
    config, workspace, api = configured

    def execute(command, environment, log, seconds):
        assert command[:2] == ["harbor", "run"]
        assert "--launch" not in command and "--upload" not in command
        assert environment["HF_TOKEN"] == "test-user-credential"
        assert "UNRELATED_SECRET" not in environment
        assert "HARBOR_HF_USER_TOKEN" not in environment
        assert seconds == 60
        result = log.parent / "example-run"
        result.mkdir()
        (result / "result.json").write_text('{"native":true}')
        log.write_text("native Harbor output")
        return exit_code

    monkeypatch.setattr(runner, "_execute", execute)
    assert runner.run(config, workspace) == exit_code
    api.sync_bucket.assert_called_once_with(
        str(workspace / "artifacts"),
        "hf://buckets/example-org/private-results/runs/example-run",
        delete=False,
        quiet=True,
    )


@pytest.mark.parametrize(
    "failure", ["identity", "public", "missing-token", "config-token"]
)
def test_fail_before_execution(configured, monkeypatch, failure):
    config, workspace, api = configured
    execute = Mock()
    monkeypatch.setattr(runner, "_execute", execute)
    if failure == "identity":
        api.whoami.return_value = {"name": "another-user"}
    elif failure == "public":
        api.bucket_info.return_value = SimpleNamespace(private=False)
    elif failure == "missing-token":
        monkeypatch.delenv("HARBOR_HF_USER_TOKEN")
    else:
        config.write_text('{"job_name":"test-user-credential"}')
    with pytest.raises(runner.RunnerError):
        runner.run(config, workspace)
    execute.assert_not_called()
    api.sync_bucket.assert_not_called()
    assert not workspace.exists()


@pytest.mark.parametrize("unsafe", ["token", "symlink", "public"])
def test_withhold_unsafe_upload(configured, monkeypatch, unsafe):
    config, workspace, api = configured

    def execute(command, env, log, seconds):
        if unsafe == "token":
            log.write_text("test-user-credential")
        elif unsafe == "symlink":
            log.symlink_to(config)
        else:
            log.write_text("safe")
            api.bucket_info.return_value = SimpleNamespace(private=False)
        return 0

    monkeypatch.setattr(runner, "_execute", execute)
    with pytest.raises(runner.RunnerError):
        runner.run(config, workspace)
    api.sync_bucket.assert_not_called()


def test_execute_real_local_child(tmp_path):
    import sys

    log = tmp_path / "runner.log"
    assert (
        runner._execute(
            [sys.executable, "-c", "print('native-output'); raise SystemExit(7)"],
            {},
            log,
            10,
        )
        == 7
    )
    assert log.read_text().strip() == "native-output"


def test_timeout_terminates_only_local_group(tmp_path, monkeypatch):
    child = Mock(pid=123)
    child.wait.side_effect = [subprocess.TimeoutExpired("harbor", 1), 0]
    context = Mock()
    context.__enter__ = Mock(return_value=child)
    context.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(runner.subprocess, "Popen", Mock(return_value=context))
    kill = Mock()
    monkeypatch.setattr(runner.os, "killpg", kill)
    assert runner._execute(["harbor"], {}, tmp_path / "log", 1) == 124
    kill.assert_called_once_with(123, signal.SIGTERM)


def test_main_does_not_print_provider_exception(monkeypatch, capsys):
    monkeypatch.setattr(runner, "run", Mock(side_effect=RuntimeError("private-secret")))
    assert runner.main() == 1
    assert "private-secret" not in capsys.readouterr().err


def test_main_decodes_dispatch_configuration(tmp_path, monkeypatch):
    source = '{"n_attempts":1}'
    monkeypatch.setenv(
        "HARBOR_HF_CONFIG_B64", base64.b64encode(source.encode()).decode()
    )
    monkeypatch.setattr(runner, "Path", lambda value: tmp_path / value.lstrip("/"))
    execute = Mock(return_value=0)
    monkeypatch.setattr(runner, "run", execute)
    assert runner.main() == 0
    config = tmp_path / "input/config.json"
    assert config.read_text() == source
    assert config.stat().st_mode & 0o777 == 0o600
    assert "HARBOR_HF_CONFIG_B64" not in os.environ
    execute.assert_called_once_with(config, tmp_path / "data/run")


@pytest.mark.parametrize("seconds", ["0", "-1", "not-a-number"])
def test_invalid_runtime(configured, monkeypatch, seconds):
    config, workspace, api = configured
    monkeypatch.setenv("HARBOR_HF_RUNTIME_SECONDS", seconds)
    with pytest.raises(runner.RunnerError, match="runtime"):
        runner.run(config, workspace)
    api.whoami.assert_not_called()


def test_plugins_rejected(configured):
    config, workspace, api = configured
    config.write_text('{"plugins":[]}')
    with pytest.raises(runner.RunnerError, match="publication"):
        runner.run(config, workspace)
    api.whoami.assert_not_called()


def test_upload_failure_is_not_success(configured, monkeypatch):
    config, workspace, api = configured
    monkeypatch.setattr(runner, "_execute", Mock(return_value=0))
    api.sync_bucket.side_effect = RuntimeError("upload failed")
    with pytest.raises(RuntimeError):
        runner.run(config, workspace)


def test_detect_token_across_read_boundary(tmp_path):
    artifact = tmp_path / "result.json"
    artifact.write_bytes(b"x" * (1024 * 1024 - 3) + b"test-user-credential")
    with pytest.raises(runner.RunnerError, match="Credential"):
        runner._check_artifacts(tmp_path, "test-user-credential")

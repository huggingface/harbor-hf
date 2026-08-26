"""Tests for the dedicated provider-agent job user."""

import stat
import subprocess
from unittest.mock import AsyncMock

import pytest

from harbor_hf_agents.pi.agent import PiAgent


@pytest.mark.asyncio
async def test_agent_commands_run_as_dedicated_unprivileged_user(temp_dir) -> None:
    agent = PiAgent(logs_dir=temp_dir)
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.exec_as_agent(
        environment,
        command="printf ready",
        env={"OPENAI_API_KEY": "scoped-agent-key"},
    )
    await agent.exec_as_agent(environment, command="id -u")

    calls = environment.exec.call_args_list
    assert len(calls) == 3
    setup, first, second = calls
    assert setup.kwargs["user"] == "root"
    assert "useradd" in setup.kwargs["command"]
    setup_command = setup.kwargs["command"]
    create_app = (
        "install -d -m 0750 -o harbor-agent -g harbor-agent "
        "/tmp/harbor-agent-home /logs/agent /app"
    )
    chown_app = "chown -R harbor-agent:harbor-agent /app"
    assert create_app in setup_command
    assert setup_command.index(create_app) < setup_command.index(chown_app)
    assert "chown -R root:root /app/data" in setup.kwargs["command"]
    assert "chmod -R a+rX,a-w /app/data" in setup.kwargs["command"]
    assert "chown root:root /app" in setup.kwargs["command"]
    assert "chmod 1777 /app" in setup.kwargs["command"]
    for call in (first, second):
        assert call.kwargs["user"] == "root"
        assert "runuser -u harbor-agent" in call.kwargs["command"]
        assert "HOME=/tmp/harbor-agent-home" in call.kwargs["command"]
        assert "NVM_DIR=/tmp/harbor-agent-home/.nvm" in call.kwargs["command"]
    assert first.kwargs["env"]["OPENAI_API_KEY"] == "scoped-agent-key"
    assert "scoped-agent-key" not in first.kwargs["command"]


def test_protected_data_stays_readable_and_nonwritable(temp_dir) -> None:
    data_dir = temp_dir / "data"
    nested_dir = data_dir / "private"
    nested_dir.mkdir(parents=True, mode=0o700)
    regular_file = nested_dir / "record.txt"
    regular_file.write_text("record")
    regular_file.chmod(0o600)
    executable_file = nested_dir / "tool.sh"
    executable_file.write_text("#!/bin/sh\n")
    executable_file.chmod(0o700)

    subprocess.run(
        ["chmod", "-R", "a+rX,a-w", str(data_dir)],
        check=True,
    )

    assert stat.S_IMODE(nested_dir.stat().st_mode) == 0o555
    assert stat.S_IMODE(regular_file.stat().st_mode) == 0o444
    assert stat.S_IMODE(executable_file.stat().st_mode) == 0o555

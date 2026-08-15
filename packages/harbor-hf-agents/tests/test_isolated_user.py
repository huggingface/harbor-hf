"""Tests for the dedicated provider-agent sandbox user."""

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
    assert "chown -R harbor-agent:harbor-agent /app" in setup.kwargs["command"]
    assert "chown -R root:root /app/data" in setup.kwargs["command"]
    assert "chmod -R a-w /app/data" in setup.kwargs["command"]
    assert "chown root:root /app" in setup.kwargs["command"]
    assert "chmod 1777 /app" in setup.kwargs["command"]
    for call in (first, second):
        assert call.kwargs["user"] == "root"
        assert "runuser -u harbor-agent" in call.kwargs["command"]
        assert "HOME=/tmp/harbor-agent-home" in call.kwargs["command"]
        assert "NVM_DIR=/tmp/harbor-agent-home/.nvm" in call.kwargs["command"]
    assert first.kwargs["env"]["OPENAI_API_KEY"] == "scoped-agent-key"
    assert "scoped-agent-key" not in first.kwargs["command"]

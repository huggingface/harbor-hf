"""Unit tests for the mini-swe-agent job inference wrapper."""

from unittest.mock import AsyncMock

import pytest
from harbor.agents.installed.mini_swe_agent import (
    MiniSweAgent as HarborMiniSweAgent,
)
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.mini_swe.agent import MiniSweAgent

_ROUTE = "harbor_hf_agents.support.job_chat_completions.use_job_inference_route"


@pytest.fixture(autouse=True)
def no_job_inference_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_ROUTE, AsyncMock(return_value=False))


def _run_call(exec_calls: list) -> object:
    for call in exec_calls:
        if "mini-swe-agent --yolo" in call.kwargs["command"]:
            return call
    raise AssertionError("No mini-swe-agent run command found in exec calls")


@pytest.mark.asyncio
async def test_job_route_injects_loopback_env(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def use_route(_agent, _environment, env, **kwargs):
        assert kwargs["base_url_key"] == "OPENAI_BASE_URL"
        assert kwargs["api_key_key"] == "MSWEA_API_KEY"
        assert kwargs["api"] == "chat-completions"
        assert kwargs["allowed_model"] == "openai/gpt-oss-20b:together"
        env["OPENAI_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["MSWEA_API_KEY"] = "harbor-local-inference-bridge"
        return True

    monkeypatch.setattr(_ROUTE, use_route)
    monkeypatch.delenv("MSWEA_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", mock_env, AgentContext())

    run_call = _run_call(mock_env.exec.call_args_list)
    assert "solve the task" in run_call.kwargs["command"]
    assert run_call.kwargs["env"]["OPENAI_BASE_URL"] == "http://127.0.0.1:18080/v1"
    assert run_call.kwargs["env"]["OPENAI_API_BASE"] == "http://127.0.0.1:18080/v1"
    assert run_call.kwargs["env"]["MSWEA_API_KEY"] == "harbor-local-inference-bridge"
    assert run_call.kwargs["env"]["OPENAI_API_KEY"] == "harbor-local-inference-bridge"


@pytest.mark.asyncio
async def test_enforces_cost_limit_with_exact_model_registry(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def use_route(_agent, _environment, env, **_kwargs):
        env["OPENAI_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["MSWEA_API_KEY"] = "harbor-local-inference-bridge"
        return True

    model = "openai/Qwen/Qwen3.8-27B:deepinfra"
    registry = {
        model: {
            "litellm_provider": "openai",
            "mode": "chat",
            "max_input_tokens": 262144,
            "max_output_tokens": 32768,
            "input_cost_per_token": 0.0000004,
            "output_cost_per_token": 0.000003,
        }
    }
    monkeypatch.setattr(_ROUTE, use_route)
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name=model,
        version="2.4.6",
        cost_limit="0.25",
        litellm_model_registry=registry,
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve", environment, AgentContext())

    commands = [call.kwargs["command"] for call in environment.exec.call_args_list]
    registry_command = next(
        command for command in commands if "registry.json" in command
    )
    run_call = _run_call(environment.exec.call_args_list)
    assert '"input_cost_per_token": 4e-07' in registry_command
    assert '"output_cost_per_token": 3e-06' in registry_command
    assert "--cost-limit 0.25" in run_call.kwargs["command"]
    assert (
        "model.litellm_model_registry=/tmp/mswea-config/registry.json"
        in run_call.kwargs["command"]
    )


@pytest.mark.asyncio
async def test_missing_job_route_fails(temp_dir) -> None:
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="Job inference route"):
        await agent.run("solve the task", mock_env, AgentContext())


@pytest.mark.asyncio
async def test_install_creates_isolated_agent_user(temp_dir) -> None:
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    mock_env = AsyncMock()
    mock_env.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(mock_env)

    first = mock_env.exec.call_args_list[0]
    assert "passwd util-linux" in first.kwargs["command"]
    install_call = next(
        call
        for call in mock_env.exec.call_args_list
        if "mini-swe-agent==2.4.6" in call.kwargs["command"]
    )
    assert install_call.kwargs["env"]["UV_PYTHON"] == "3.12"

    mock_env.exec.reset_mock()
    await agent.exec_as_agent(mock_env, command="true")

    assert "UV_PYTHON" not in mock_env.exec.await_args.kwargs["env"]


@pytest.mark.asyncio
async def test_declared_install_environment_takes_precedence(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def install_with_caller_environment(agent, environment) -> None:
        await agent.exec_as_agent(
            environment,
            command="install-probe",
            env={"KEEP": "value", "UV_PYTHON": "3.10"},
        )

    monkeypatch.setattr(HarborMiniSweAgent, "install", install_with_caller_environment)
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(environment)

    install_call = next(
        call
        for call in environment.exec.call_args_list
        if "install-probe" in call.kwargs["command"]
    )
    assert install_call.kwargs["env"]["KEEP"] == "value"
    assert install_call.kwargs["env"]["UV_PYTHON"] == "3.12"


@pytest.mark.asyncio
async def test_reentrant_install_fails_closed(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def reenter_install(agent, environment) -> None:
        await agent.install(environment)

    monkeypatch.setattr(HarborMiniSweAgent, "install", reenter_install)
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="^agent installation is already active$"):
        await agent.install(environment)


@pytest.mark.asyncio
async def test_failed_install_clears_install_environment(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_install(agent, environment) -> None:
        await agent.exec_as_agent(environment, command="failing-install")
        raise RuntimeError("install failed")

    monkeypatch.setattr(HarborMiniSweAgent, "install", fail_install)
    agent = MiniSweAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    with pytest.raises(RuntimeError, match="install failed"):
        await agent.install(environment)

    environment.exec.reset_mock()
    await agent.exec_as_agent(environment, command="true")

    assert "UV_PYTHON" not in environment.exec.await_args.kwargs["env"]

    async def succeed_install(_agent, _environment) -> None:
        return None

    monkeypatch.setattr(HarborMiniSweAgent, "install", succeed_install)
    await agent.install(environment)


@pytest.mark.asyncio
async def test_duplicate_install_environment_key_fails_closed(temp_dir) -> None:
    class DuplicateInstallEnvironmentAgent(MiniSweAgent):
        install_environment = (
            ("UV_PYTHON", "3.11"),
            ("UV_PYTHON", "3.12"),
        )

    agent = DuplicateInstallEnvironmentAgent(
        logs_dir=temp_dir,
        model_name="openai/openai/gpt-oss-20b:together",
        version="2.4.6",
    )
    environment = AsyncMock()

    with pytest.raises(RuntimeError, match="duplicate install environment key"):
        await agent.install(environment)

    environment.exec.assert_not_awaited()

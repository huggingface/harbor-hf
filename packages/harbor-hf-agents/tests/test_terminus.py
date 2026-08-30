"""Unit tests for the Terminus Job inference wrapper."""

from unittest.mock import AsyncMock

import pytest
from harbor.agents.terminus_2 import Terminus2
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.support import job_inference_route
from harbor_hf_agents.support.control_job_environment import ControlJobEnvironment
from harbor_hf_agents.support.job_inference_route import JobInferenceRoute
from harbor_hf_agents.terminus import agent as terminus_module
from harbor_hf_agents.terminus.agent import TerminusAgent, _JobTmuxSession


def _agent(temp_dir) -> TerminusAgent:
    return TerminusAgent(
        logs_dir=temp_dir,
        model_name="openai/Qwen/Qwen3.8-27B:deepinfra",
        api_base="http://127.0.0.1:18080/v1",
        llm_backend="litellm",
        llm_kwargs={"api_key": "harbor-local-inference-bridge"},
        model_info={
            "litellm_provider": "openai",
            "max_input_tokens": 262144,
            "max_output_tokens": 32768,
        },
        record_terminal_session=False,
        use_responses_api=False,
    )


@pytest.mark.asyncio
async def test_tmux_setup_returns_when_the_detached_session_is_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[str] = []

    async def exec_command(command: str, **_kwargs: object) -> ExecResult:
        commands.append(command)
        return ExecResult(stdout="", stderr="", return_code=0)

    environment = AsyncMock(spec=ControlJobEnvironment)
    environment.exec.side_effect = exec_command
    session = _JobTmuxSession(
        session_name="terminus-2",
        environment=environment,
        logging_path="/logs/agent/terminus_2.pane",
        local_asciinema_recording_path=None,
        remote_asciinema_recording_path=None,
        user="root",
    )
    monkeypatch.setattr(session, "_attempt_tmux_installation", AsyncMock())

    await session.start()

    environment.start_background.assert_awaited_once()
    startup_command = environment.start_background.await_args.kwargs["command"]
    assert "tmux new-session" in startup_command
    assert "tmux has-session -t terminus-2" in commands
    assert "tmux set-option -g history-limit 10000000" in commands


@pytest.mark.asyncio
async def test_tmux_setup_reports_a_startup_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = AsyncMock(spec=ControlJobEnvironment)
    environment.start_background.side_effect = RuntimeError("tmux failed")
    session = _JobTmuxSession(
        session_name="terminus-2",
        environment=environment,
        logging_path="/logs/agent/terminus_2.pane",
        local_asciinema_recording_path=None,
        remote_asciinema_recording_path=None,
        user="root",
    )
    monkeypatch.setattr(session, "_attempt_tmux_installation", AsyncMock())

    with pytest.raises(RuntimeError, match="tmux failed"):
        await session.start()


@pytest.mark.asyncio
async def test_agent_setup_uses_the_detached_job_tmux_session(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = AsyncMock()
    monkeypatch.setattr(_JobTmuxSession, "start", start)
    environment = AsyncMock()
    environment.default_user = "root"
    agent = _agent(temp_dir)

    await agent.setup(environment)

    assert isinstance(agent._session, _JobTmuxSession)
    start.assert_awaited_once_with()


def test_keeps_public_terminus_identity(temp_dir) -> None:
    agent = _agent(temp_dir)

    assert agent.name() == "terminus-2"
    assert agent.version() == "2.0.0"


@pytest.mark.asyncio
async def test_runs_with_the_exact_locked_chat_route(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, str] = {}

    def load_route(*, api: str, allowed_model: str) -> JobInferenceRoute:
        seen["api"] = api
        seen["model"] = allowed_model
        return JobInferenceRoute(
            base_url="http://127.0.0.1:18080/v1",
            api_key="harbor-local-inference-bridge",
            max_output_tokens=32768,
        )

    run = AsyncMock()
    stop = AsyncMock()
    monkeypatch.setattr(terminus_module, "load_job_inference_route", load_route)
    monkeypatch.setattr(Terminus2, "run", run)
    monkeypatch.setattr(job_inference_route, "stop_hf_inference_bridge", stop)
    agent = _agent(temp_dir)
    environment = AsyncMock()
    context = AgentContext()

    await agent.run("solve", environment, context)

    assert seen == {
        "api": "chat-completions",
        "model": "Qwen/Qwen3.8-27B:deepinfra",
    }
    run.assert_awaited_once_with("solve", environment, context)
    stop.assert_awaited_once_with(agent, environment)


@pytest.mark.asyncio
async def test_rejects_a_configured_route_mismatch(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        terminus_module,
        "load_job_inference_route",
        lambda **_kwargs: JobInferenceRoute(
            base_url="http://127.0.0.1:18081/v1",
            api_key="harbor-local-inference-bridge",
            max_output_tokens=32768,
        ),
    )
    run = AsyncMock()
    stop = AsyncMock()
    monkeypatch.setattr(Terminus2, "run", run)
    monkeypatch.setattr(job_inference_route, "stop_hf_inference_bridge", stop)
    agent = _agent(temp_dir)

    with pytest.raises(RuntimeError, match="API base does not match"):
        await agent.run("solve", AsyncMock(), AgentContext())

    run.assert_not_awaited()
    stop.assert_awaited_once()


@pytest.mark.asyncio
async def test_rejects_missing_route(temp_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        terminus_module,
        "load_job_inference_route",
        lambda **_kwargs: None,
    )
    run = AsyncMock()
    monkeypatch.setattr(Terminus2, "run", run)
    agent = _agent(temp_dir)

    with pytest.raises(RuntimeError, match="requires the Job inference route"):
        await agent.run("solve", AsyncMock(), AgentContext())

    run.assert_not_awaited()


@pytest.mark.parametrize(
    ("attribute", "value", "message"),
    [
        ("_llm_kwargs", {"api_key": "wrong"}, "API key does not match"),
        ("_use_responses_api", True, "must use the Chat Completions route"),
    ],
)
@pytest.mark.asyncio
async def test_rejects_unsafe_litellm_configuration(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
    attribute: str,
    value: object,
    message: str,
) -> None:
    monkeypatch.setattr(
        terminus_module,
        "load_job_inference_route",
        lambda **_kwargs: JobInferenceRoute(
            base_url="http://127.0.0.1:18080/v1",
            api_key="harbor-local-inference-bridge",
            max_output_tokens=32768,
        ),
    )
    run = AsyncMock()
    stop = AsyncMock()
    monkeypatch.setattr(Terminus2, "run", run)
    monkeypatch.setattr(job_inference_route, "stop_hf_inference_bridge", stop)
    agent = _agent(temp_dir)
    setattr(agent._llm, attribute, value)

    with pytest.raises(RuntimeError, match=message):
        await agent.run("solve", AsyncMock(), AgentContext())

    run.assert_not_awaited()
    stop.assert_awaited_once()

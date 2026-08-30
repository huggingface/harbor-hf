"""Unit tests for the standalone Codex Job inference wrapper."""

from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.codex.agent import CodexAgent

_ROUTE = "harbor_hf_agents.support.job_chat_completions.use_job_inference_route"


def _command_calls(environment: AsyncMock) -> list[str]:
    return [call.kwargs["command"] for call in environment.exec.call_args_list]


def _codex_call(environment: AsyncMock):
    return next(
        call
        for call in environment.exec.call_args_list
        if "codex exec" in call.kwargs["command"]
    )


def test_keeps_standalone_codex_identity(temp_dir) -> None:
    agent = CodexAgent(
        logs_dir=temp_dir,
        model_name="openai/Qwen/Qwen3.8-27B:deepinfra",
        version="0.118.0",
        reasoning_effort="none",
    )

    assert agent.name() == "codex"
    assert agent.version() == "0.118.0"


def test_uses_http_only_responses_provider_without_web_search(temp_dir) -> None:
    agent = CodexAgent(
        logs_dir=temp_dir,
        model_name="openai/Qwen/Qwen3.8-27B:deepinfra",
        version="0.118.0",
        reasoning_effort="none",
    )

    config = agent._build_effective_config("http://127.0.0.1:18080/v1")

    assert config["model_provider"] == "harbor_hf"
    assert config["web_search"] == "disabled"
    assert "openai_base_url" not in config
    assert config["model_providers"] == {
        "harbor_hf": {
            "name": "Harbor-HF loopback bridge",
            "base_url": "http://127.0.0.1:18080/v1",
            "env_key": "OPENAI_API_KEY",
            "wire_api": "responses",
            "supports_websockets": False,
        }
    }


def test_disables_web_search_without_a_route(temp_dir) -> None:
    agent = CodexAgent(logs_dir=temp_dir, model_name="openai/model")

    assert agent._build_effective_config() == {"web_search": "disabled"}


def test_forces_web_search_disabled_in_cli_flags(temp_dir) -> None:
    agent = CodexAgent(
        logs_dir=temp_dir,
        model_name="openai/model",
        web_search="live",
    )

    assert agent.build_cli_flags().split().count("web_search=disabled") == 1
    assert "web_search=live" not in agent.build_cli_flags()


def test_rejects_invalid_model_provider_config(temp_dir) -> None:
    agent = CodexAgent(logs_dir=temp_dir, model_name="openai/model")
    agent._base_config = {"model_providers": []}

    with pytest.raises(ValueError, match="model_providers must be a TOML table"):
        agent._build_effective_config("http://127.0.0.1:18080/v1")


@pytest.mark.asyncio
async def test_uses_responses_route_and_preserves_full_model_id(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, str] = {}

    async def use_route(_agent, _environment, env, **kwargs):
        seen.update(kwargs)
        env["OPENAI_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["OPENAI_API_KEY"] = "harbor-local-inference-bridge"
        return True

    monkeypatch.setattr(_ROUTE, use_route)
    agent = CodexAgent(
        logs_dir=temp_dir,
        model_name="openai/Qwen/Qwen3.8-27B:deepinfra",
        version="0.118.0",
        reasoning_effort="none",
    )
    environment = AsyncMock()
    environment.default_user = None
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("solve the task", environment, AgentContext())

    assert seen == {
        "base_url_key": "OPENAI_BASE_URL",
        "api_key_key": "OPENAI_API_KEY",
        "api": "responses",
        "allowed_model": "Qwen/Qwen3.8-27B:deepinfra",
    }
    call = _codex_call(environment)
    command = call.kwargs["command"]
    assert "--model Qwen/Qwen3.8-27B:deepinfra" in command
    assert "--model Qwen3.8-27B:deepinfra" not in command
    assert "runuser -u harbor-agent" in command
    assert call.kwargs["env"]["OPENAI_BASE_URL"] == "http://127.0.0.1:18080/v1"
    assert call.kwargs["env"]["OPENAI_API_KEY"] == "harbor-local-inference-bridge"


@pytest.mark.asyncio
async def test_preserves_harbor_auth_resume_and_skill_setup(
    temp_dir,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def use_route(_agent, _environment, env, **_kwargs):
        env["OPENAI_BASE_URL"] = "http://127.0.0.1:18080/v1"
        env["OPENAI_API_KEY"] = "harbor-local-inference-bridge"
        return True

    monkeypatch.setattr(_ROUTE, use_route)
    auth_path = temp_dir / "auth.json"
    auth_path.write_text("{}\n")
    agent = CodexAgent(
        logs_dir=temp_dir,
        model_name="openai/Qwen/Qwen3.8-27B:deepinfra",
        version="0.118.0",
        reasoning_effort="none",
    )
    seed = AsyncMock()
    monkeypatch.setattr(agent, "_resolve_auth_json_path", lambda: auth_path)
    monkeypatch.setattr(agent, "_seed_load_trajectory", seed)
    monkeypatch.setattr(agent, "_build_register_skills_command", lambda: "add-skills")
    agent._load = True
    environment = AsyncMock()
    environment.default_user = "task-user"
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.run("resume", environment, AgentContext())

    seed.assert_awaited_once_with(environment)
    assert (auth_path, "/tmp/codex-secrets/auth.json") in [
        call.args for call in environment.upload_file.await_args_list
    ]
    commands = _command_calls(environment)
    assert any("chown harbor-agent /tmp/codex-secrets/auth.json" in c for c in commands)
    setup = next(command for command in commands if "add-skills" in command)
    assert "Cannot resume Codex" in setup
    assert "add-skills" in setup
    assert "resume --last" in _codex_call(environment).kwargs["command"]


@pytest.mark.asyncio
async def test_installs_exact_official_codex_version(temp_dir) -> None:
    agent = CodexAgent(
        logs_dir=temp_dir,
        model_name="openai/Qwen/Qwen3.8-27B:deepinfra",
        version="0.118.0",
        reasoning_effort="none",
    )
    environment = AsyncMock()
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")

    await agent.install(environment)

    commands = _command_calls(environment)
    assert any("@openai/codex@0.118.0" in command for command in commands)
    assert all("openclaw" not in command for command in commands)
    assert any("runuser -u harbor-agent" in command for command in commands)

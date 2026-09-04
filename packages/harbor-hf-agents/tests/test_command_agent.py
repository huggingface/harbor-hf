"""Focused tests for the generic command-agent recipe."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from harbor.models.agent.context import AgentContext
from pydantic import ValidationError

from harbor_hf_agents.command_agent import (
    CommandAgent,
    CommandAgentConfig,
)


def _config(
    *,
    setup: dict[str, object] | None = None,
    run: dict[str, object] | None = None,
    outputs: list[dict[str, object]] | None = None,
    atif: dict[str, object] | None = None,
) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": "v1",
        "run": run or {"argv": ["agent-cli", "run"]},
    }
    if setup is not None:
        value["setup"] = setup
    if outputs is not None:
        value["outputs"] = outputs
    if atif is not None:
        value["atif"] = atif
    return value


def _environment(
    logs_root: Path | None = None,
    *,
    mounted: bool = True,
) -> AsyncMock:
    environment = AsyncMock()
    environment.capabilities.mounted = mounted
    environment.exec.return_value = AsyncMock(return_code=0, stdout="", stderr="")
    if logs_root is not None:

        async def upload(source: Path, target: str) -> None:
            destination = logs_root / Path(target).relative_to("/logs/agent")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

        async def download(source: str, target: Path) -> None:
            origin = logs_root / Path(source).relative_to("/logs/agent")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)

        environment.upload_file.side_effect = upload
        environment.download_file.side_effect = download
    return environment


def _phase_call(environment: AsyncMock, phase: str) -> object:
    return next(
        call
        for call in environment.exec.call_args_list
        if f"/{phase}.log" in call.kwargs["command"]
    )


def test_config_is_strict_and_requires_one_command_form() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        CommandAgentConfig.model_validate(
            {**_config(), "environment": {"AMBIENT": "value"}}
        )
    with pytest.raises(ValidationError, match="exactly one"):
        CommandAgentConfig.model_validate(
            _config(run={"argv": ["agent"], "script": "agent"})
        )
    with pytest.raises(ValidationError, match="exactly one"):
        CommandAgentConfig.model_validate(_config(run={"bindings": {}}))
    with pytest.raises(ValidationError):
        CommandAgentConfig.model_validate(_config(run={"argv": [1]}))


@pytest.mark.parametrize(
    "name",
    [
        "HOME",
        "HARBOR_HF_TOKEN",
        "OPENAI_API_KEY",
        "ROUTE_CREDENTIAL",
        "LD_PRELOAD",
        "lowercase",
    ],
)
def test_config_rejects_reserved_and_credential_environment_names(name: str) -> None:
    with pytest.raises(ValidationError, match="reserved|portable|credential"):
        CommandAgentConfig.model_validate(
            _config(
                run={
                    "argv": ["agent"],
                    "bindings": {name: "workspace_path"},
                }
            )
        )


def test_config_allows_a_credential_name_only_for_the_model_credential() -> None:
    config = CommandAgentConfig.model_validate(
        _config(
            run={
                "argv": ["agent"],
                "bindings": {"GENERIC_API_KEY": "model_api_key"},
            }
        )
    )
    assert config.run.bindings == {"GENERIC_API_KEY": "model_api_key"}

    for source in ("workspace_path", "model_name"):
        with pytest.raises(ValidationError, match="credential"):
            CommandAgentConfig.model_validate(
                _config(
                    run={
                        "argv": ["agent"],
                        "bindings": {"GENERIC_API_KEY": source},
                    }
                )
            )
    with pytest.raises(ValidationError, match="credential"):
        CommandAgentConfig.model_validate(
            _config(
                run={
                    "argv": ["agent"],
                    "literals": {"GENERIC_API_KEY": "not-a-secret"},
                }
            )
        )


def test_config_accepts_only_the_declared_binding_types() -> None:
    bindings = {
        "TASK_FILE": "instruction_path",
        "WORKSPACE": "workspace_path",
        "LOG_DIRECTORY": "logs_path",
        "AGENT_DIRECTORY": "agent_home",
        "MODEL": "model_name",
        "MODEL_URL": "model_base_url",
        "MODEL_CREDENTIAL": "model_api_key",
        "VERSION": "agent_version",
    }
    config = CommandAgentConfig.model_validate(
        _config(run={"script": "agent", "bindings": bindings})
    )
    assert config.run.bindings == bindings

    with pytest.raises(ValidationError):
        CommandAgentConfig.model_validate(
            _config(
                run={
                    "argv": ["agent"],
                    "bindings": {"CUSTOM": "literal_value"},
                }
            )
        )


def test_config_accepts_non_secret_literals_and_rejects_duplicates() -> None:
    config = CommandAgentConfig.model_validate(
        _config(run={"argv": ["agent"], "literals": {"DISPLAY_MODE": "compact"}})
    )
    assert config.run.literals == {"DISPLAY_MODE": "compact"}

    with pytest.raises(ValidationError, match="duplicated"):
        CommandAgentConfig.model_validate(
            _config(
                run={
                    "argv": ["agent"],
                    "bindings": {"DISPLAY_MODE": "model_name"},
                    "literals": {"DISPLAY_MODE": "compact"},
                }
            )
        )


def test_setup_rejects_bindings_that_exist_only_during_run() -> None:
    for binding in ("instruction_path", "model_base_url", "model_api_key"):
        with pytest.raises(ValidationError, match="run-only"):
            CommandAgentConfig.model_validate(
                _config(
                    setup={
                        "argv": ["setup"],
                        "bindings": {"VALUE": binding},
                    }
                )
            )


def test_atif_output_must_stay_beneath_logs() -> None:
    for path in ("/tmp/trace.json", "../trace.json", "trace.txt"):
        with pytest.raises(ValidationError, match="relative JSON path"):
            CommandAgentConfig.model_validate(_config(atif={"path": path}))


def test_declared_outputs_are_relative_unique_and_separate_from_atif() -> None:
    for path in ("/tmp/result.json", "../result.json"):
        with pytest.raises(ValidationError, match="relative and beneath logs"):
            CommandAgentConfig.model_validate(_config(outputs=[{"path": path}]))
    with pytest.raises(ValidationError, match="unique"):
        CommandAgentConfig.model_validate(
            _config(outputs=[{"path": "result.json"}, {"path": "result.json"}])
        )
    with pytest.raises(ValidationError, match="must not duplicate"):
        CommandAgentConfig.model_validate(
            _config(
                outputs=[{"path": "trajectory.json"}],
                atif={"path": "trajectory.json"},
            )
        )


def test_rejects_arbitrary_extra_env(temp_dir: Path) -> None:
    with pytest.raises(ValueError, match="does not accept unsupported environment"):
        CommandAgent(
            logs_dir=temp_dir,
            config=_config(),
            extra_env={"SAFE_LOOKING": "value"},
        )


def test_config_can_be_loaded_through_harbor_config_path(temp_dir: Path) -> None:
    path = temp_dir / "command-agent.json"
    path.write_text(json.dumps(_config(run={"script": "printf ready\n"})))

    agent = CommandAgent(logs_dir=temp_dir, config=path, version="2.0.0")

    assert agent.command_config.run.script == "printf ready\n"
    assert agent.version() == "2.0.0"


@pytest.mark.asyncio
async def test_setup_and_run_argv_are_unprivileged_and_ambient_free(
    temp_dir: Path,
) -> None:
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(
            setup={
                "argv": ["python3", "-m", "pip", "install", "example==1.2.3"],
                "bindings": {
                    "WORKSPACE": "workspace_path",
                    "AGENT_DIRECTORY": "agent_home",
                },
            },
            run={
                "argv": ["agent-cli", "--flag", "value with spaces"],
                "bindings": {
                    "TASK_FILE": "instruction_path",
                    "WORKSPACE": "workspace_path",
                    "LOG_DIRECTORY": "logs_path",
                    "VERSION": "agent_version",
                },
            },
        ),
        version="1.2.3",
    )
    environment = _environment(temp_dir)

    await agent.setup(environment)
    await agent.run("do not place me in a command", environment, AgentContext())

    setup = _phase_call(environment, "setup")
    run = _phase_call(environment, "run")
    for call in (setup, run):
        command = call.kwargs["command"]
        assert "runuser -u harbor-agent" in command
        assert "env -i" in command
        assert call.kwargs["cwd"] == "/app"
        assert call.kwargs["user"] == "root"
    assert "python3 -m pip install example==1.2.3" in setup.kwargs["command"]
    assert "agent-cli --flag" in run.kwargs["command"]
    assert "value with spaces" in run.kwargs["command"]
    assert run.kwargs["env"] == {
        "LOG_DIRECTORY": "/logs/agent",
        "TASK_FILE": "/logs/agent/instruction.txt",
        "VERSION": "1.2.3",
        "WORKSPACE": "/app",
    }
    assert "do not place me in a command" not in run.kwargs["command"]
    assert "do not place me in a command" not in run.kwargs["env"].values()
    assert (temp_dir / "instruction.txt").read_text() == (
        "do not place me in a command"
    )


@pytest.mark.asyncio
async def test_scripts_are_staged_verbatim_and_process_logs_are_bounded(
    temp_dir: Path,
) -> None:
    setup_script = "printf 'setup %s\\n' \"$AGENT_DIRECTORY\"\n"
    run_script = 'cat "$TASK_FILE"\n'
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(
            setup={
                "script": setup_script,
                "bindings": {"AGENT_DIRECTORY": "agent_home"},
            },
            run={
                "script": run_script,
                "bindings": {"TASK_FILE": "instruction_path"},
            },
        ),
    )
    environment = _environment(temp_dir)

    await agent.setup(environment)
    await agent.run("solve", environment, AgentContext())

    assert (temp_dir / "command-agent" / "setup.sh").read_text() == setup_script
    assert (temp_dir / "command-agent" / "run.sh").read_text() == run_script
    commands = [call.kwargs["command"] for call in environment.exec.call_args_list]
    user_create = next(command for command in commands if "useradd" in command)
    setup_chown = next(
        command
        for command in commands
        if ("chown harbor-agent:harbor-agent /logs/agent/command-agent/setup.sh")
        in command
    )
    assert commands.index(user_create) < commands.index(setup_chown)
    setup = _phase_call(environment, "setup")
    run = _phase_call(environment, "run")
    assert "/logs/agent/command-agent/setup.sh" in setup.kwargs["command"]
    assert "/logs/agent/command-agent/run.sh" in run.kwargs["command"]
    assert "tee /logs/agent/setup.log" in setup.kwargs["command"]
    assert "tee /logs/agent/run.log" in run.kwargs["command"]


@pytest.mark.asyncio
async def test_model_bindings_use_direct_agent_environment(temp_dir: Path) -> None:
    agent = CommandAgent(
        logs_dir=temp_dir,
        model_name="openai/example/model",
        extra_env={
            "OPENAI_BASE_URL": "https://router.huggingface.co/v1",
            "OPENAI_API_KEY": "direct-token",
        },
        config=_config(
            run={
                "argv": ["agent"],
                "bindings": {
                    "MODEL_URL": "model_base_url",
                    "MODEL_CREDENTIAL": "model_api_key",
                    "MODEL": "model_name",
                },
            }
        ),
    )
    environment = _environment(temp_dir)

    await agent.run("solve", environment, AgentContext())

    run = _phase_call(environment, "run")
    assert run.kwargs["env"] == {
        "MODEL": "openai/example/model",
        "MODEL_URL": "https://router.huggingface.co/v1",
        "MODEL_CREDENTIAL": "direct-token",
    }


@pytest.mark.asyncio
async def test_model_binding_fails_closed_without_direct_settings(
    temp_dir: Path,
) -> None:
    agent = CommandAgent(
        logs_dir=temp_dir,
        model_name="openai/example/model",
        config=_config(
            run={
                "argv": ["agent"],
                "bindings": {"MODEL_URL": "model_base_url"},
            }
        ),
    )

    with pytest.raises(RuntimeError, match="requires direct model settings"):
        await agent.run("solve", _environment(temp_dir), AgentContext())


@pytest.mark.asyncio
async def test_declared_outputs_are_collected_into_agent_logs(temp_dir: Path) -> None:
    produced = temp_dir / "native" / "result.json"
    produced.parent.mkdir()
    produced.write_text('{"reward": 1}\n')
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(outputs=[{"path": "native/result.json"}]),
    )

    await agent.run("solve", _environment(temp_dir), AgentContext())

    assert produced.read_text() == '{"reward": 1}\n'


@pytest.mark.asyncio
async def test_declared_output_must_be_present(temp_dir: Path) -> None:
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(outputs=[{"path": "missing.json"}]),
    )
    environment = _environment(temp_dir)
    environment.download_file.side_effect = FileNotFoundError

    with pytest.raises(RuntimeError, match="Declared output was not produced"):
        await agent.run("solve", environment, AgentContext())


@pytest.mark.asyncio
async def test_declared_atif_is_validated_canonicalized_and_ingested(
    temp_dir: Path,
) -> None:
    trace = temp_dir / "native" / "trace.json"
    trace.parent.mkdir()
    trace.write_text(
        json.dumps(
            {
                "schema_version": "ATIF-v1.7",
                "session_id": "session",
                "agent": {
                    "name": "customer-agent",
                    "version": "0.4.0",
                    "model_name": "provider/model",
                },
                "steps": [{"step_id": 1, "source": "agent", "message": "done"}],
                "final_metrics": {
                    "total_prompt_tokens": 11,
                    "total_completion_tokens": 7,
                    "total_cached_tokens": 3,
                    "total_cost_usd": 0.25,
                    "total_steps": 1,
                },
            }
        )
    )
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(atif={"path": "native/trace.json"}),
    )
    context = AgentContext()

    await agent.run("solve", _environment(temp_dir), context)

    canonical = json.loads((temp_dir / "trajectory.json").read_text())
    assert canonical["agent"]["name"] == "customer-agent"
    assert context.n_input_tokens == 11
    assert context.n_output_tokens == 7
    assert context.n_cache_tokens == 3
    assert context.cost_usd == 0.25


@pytest.mark.asyncio
async def test_declared_atif_must_be_present_and_valid(temp_dir: Path) -> None:
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(atif={"path": "trace.json"}),
    )
    environment = _environment(temp_dir)
    environment.download_file.side_effect = FileNotFoundError

    with pytest.raises(RuntimeError, match="was not produced"):
        await agent.run("solve", environment, AgentContext())

    (temp_dir / "trace.json").write_text("{}")
    environment = _environment(temp_dir)
    with pytest.raises(RuntimeError, match="is invalid"):
        await agent.run("solve", environment, AgentContext())


@pytest.mark.asyncio
async def test_atif_null_metrics_do_not_erase_existing_context(temp_dir: Path) -> None:
    (temp_dir / "trace.json").write_text(
        json.dumps(
            {
                "schema_version": "ATIF-v1.7",
                "agent": {"name": "customer-agent", "version": "1"},
                "steps": [{"step_id": 1, "source": "agent", "message": "done"}],
                "final_metrics": {"total_steps": 1},
            }
        )
    )
    context = AgentContext(n_input_tokens=5, cost_usd=0.1)
    agent = CommandAgent(
        logs_dir=temp_dir,
        config=_config(atif={"path": "trace.json"}),
    )

    await agent.run("solve", _environment(temp_dir), context)

    assert context.n_input_tokens == 5
    assert context.cost_usd == 0.1


def _fast_agent_0_10_16_starter() -> dict[str, object]:
    """Test-only proof that Fast-Agent is ordinary command recipe data."""
    return _config(
        setup={
            "argv": [
                "python3",
                "-m",
                "pip",
                "install",
                "fast-agent-mcp==0.10.16",
            ]
        },
        run={
            "script": (
                'exec "$AGENT_DIRECTORY/.local/bin/fast-agent" go '
                '--model "$MODEL" --message "$(cat "$TASK_FILE")"\n'
            ),
            "bindings": {
                "AGENT_DIRECTORY": "agent_home",
                "MODEL": "model_name",
                "MODEL_BASE_URL": "model_base_url",
                "OPENAI_API_KEY": "model_api_key",
                "TASK_FILE": "instruction_path",
            },
        },
    )


def test_fast_agent_0_10_16_starter_uses_the_generic_recipe() -> None:
    config = CommandAgentConfig.model_validate(_fast_agent_0_10_16_starter())
    assert config.setup is not None
    assert config.setup.argv[-1] == "fast-agent-mcp==0.10.16"
    assert config.run.bindings["MODEL_BASE_URL"] == "model_base_url"

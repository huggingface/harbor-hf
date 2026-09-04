"""Generic command recipe implemented through Harbor's installed-agent API."""

from __future__ import annotations

import os
import re
import shlex
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Literal, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from harbor.utils.env import is_sensitive_env_key
from harbor.utils.trajectory_utils import format_trajectory_json
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictStr,
    model_validator,
)

from harbor_hf_agents.support.isolated_user import (
    AGENT_HOME,
    AGENT_USER,
    IsolatedProviderAgent,
)

type CommandBinding = Literal[
    "instruction_path",
    "workspace_path",
    "logs_path",
    "agent_home",
    "model_name",
    "model_base_url",
    "model_api_key",
    "agent_version",
]
type RouteApi = Literal["chat-completions", "responses"]

_WORKSPACE_PATH = "/app"
_LOGS_PATH = "/logs/agent"
_INSTRUCTION_PATH = f"{_LOGS_PATH}/instruction.txt"
_MAX_ATIF_BYTES = 64 * 1024 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_RESERVED_ENV_NAMES = frozenset(
    {
        "BASH_ENV",
        "CDPATH",
        "DEBIAN_FRONTEND",
        "ENV",
        "HOME",
        "IFS",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "LOGNAME",
        "NVM_DIR",
        "OLDPWD",
        "PATH",
        "PROMPT_COMMAND",
        "PS4",
        "PWD",
        "PYTHONHOME",
        "PYTHONPATH",
        "SHELL",
        "USER",
    }
)


def _validate_environment_name(
    name: str,
    *,
    allow_model_credential: bool = False,
) -> None:
    if _ENV_NAME.fullmatch(name) is None:
        raise ValueError(f"binding environment name {name!r} is not a portable name")
    if name in _RESERVED_ENV_NAMES or name.startswith("HARBOR_"):
        raise ValueError(
            f"binding environment name {name!r} is reserved or credential-like"
        )
    if is_sensitive_env_key(name) and not allow_model_credential:
        raise ValueError(
            f"binding environment name {name!r} is reserved or credential-like"
        )


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class CommandSpec(_StrictModel):
    """One unprivileged command and its explicitly typed environment bindings."""

    argv: list[StrictStr] | None = Field(default=None, min_length=1)
    script: StrictStr | None = Field(default=None, min_length=1)
    bindings: dict[StrictStr, CommandBinding] = Field(default_factory=dict)
    literals: dict[StrictStr, StrictStr] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_command(self) -> CommandSpec:
        if (self.argv is None) == (self.script is None):
            raise ValueError("command requires exactly one of argv or script")
        duplicated = set(self.bindings).intersection(self.literals)
        if duplicated:
            names = ", ".join(sorted(duplicated))
            raise ValueError(f"command environment names are duplicated: {names}")
        for name, binding in self.bindings.items():
            _validate_environment_name(
                name,
                allow_model_credential=binding == "model_api_key",
            )
        for name in self.literals:
            _validate_environment_name(name)
        for value in self.literals.values():
            if "\0" in value:
                raise ValueError("literal environment values must not contain NUL")
        return self


class AtifOutput(_StrictModel):
    """A command-produced ATIF document beneath ``/logs/agent``."""

    path: StrictStr = Field(min_length=1)

    @model_validator(mode="after")
    def validate_path(self) -> AtifOutput:
        path = PurePosixPath(self.path)
        if (
            path.is_absolute()
            or ".." in path.parts
            or path.name in {"", ".", ".."}
            or path.suffix != ".json"
        ):
            raise ValueError("ATIF path must be a relative JSON path beneath logs")
        return self


class DeclaredOutput(_StrictModel):
    """A required command-produced file beneath ``/logs/agent``."""

    path: StrictStr = Field(min_length=1)

    @model_validator(mode="after")
    def validate_path(self) -> DeclaredOutput:
        path = PurePosixPath(self.path)
        if path.is_absolute() or ".." in path.parts or path.name in {"", ".", ".."}:
            raise ValueError("output path must be relative and beneath logs")
        return self


class CommandAgentConfig(_StrictModel):
    """Versioned, secret-free command-agent recipe."""

    schema_version: Literal["v1"]
    setup: CommandSpec | None = None
    run: CommandSpec
    route_api: RouteApi = "chat-completions"
    outputs: list[DeclaredOutput] = Field(default_factory=list, max_length=32)
    atif: AtifOutput | None = None

    @model_validator(mode="after")
    def validate_phase_bindings(self) -> CommandAgentConfig:
        output_paths = [item.path for item in self.outputs]
        if len(set(output_paths)) != len(output_paths):
            raise ValueError("declared output paths must be unique")
        if self.atif is not None and self.atif.path in output_paths:
            raise ValueError("ATIF path must not duplicate a declared output")
        if self.setup is None:
            return self
        unavailable = {
            "instruction_path",
            "model_base_url",
            "model_api_key",
        }.intersection(self.setup.bindings.values())
        if unavailable:
            names = ", ".join(sorted(unavailable))
            raise ValueError(f"setup cannot use run-only bindings: {names}")
        return self


def _read_config(
    source: Path | dict[str, Any] | None,
) -> CommandAgentConfig:
    if source is None:
        raise ValueError("Command agent requires config")
    if isinstance(source, Path):
        try:
            return CommandAgentConfig.model_validate_json(source.read_text())
        except OSError as error:
            raise ValueError(f"Cannot read command-agent config: {error}") from error
    return CommandAgentConfig.model_validate(source)


class CommandAgent(IsolatedProviderAgent):
    """Execute a strict customer recipe without harness or model special cases."""

    capabilities = AgentCapabilities(atif=True, native_config=True)

    def __init__(
        self,
        logs_dir: Path,
        prompt_template_path: Path | str | None = None,
        version: str | None = None,
        extra_env: dict[str, str] | None = None,
        *,
        config: Path | str | dict[str, Any] | None = None,
        **kwargs: Any,  # noqa: ANN401 -- Harbor API
    ) -> None:
        allowed_environment = {"OPENAI_API_KEY", "OPENAI_BASE_URL"}
        unexpected = set(extra_env or {}) - allowed_environment
        if unexpected:
            names = ", ".join(sorted(unexpected))
            raise ValueError(
                "Command agent does not accept unsupported environment "
                f"variables: {names}"
            )
        super().__init__(
            logs_dir=logs_dir,
            prompt_template_path=prompt_template_path,
            version=version,
            extra_env=extra_env,
            config=config,
            **kwargs,
        )
        self.command_config = _read_config(self.config_source)

    @staticmethod
    @override
    def name() -> str:
        return "command-agent"

    @override
    def get_version_command(self) -> str | None:
        return None

    async def _stage_text(
        self,
        environment: BaseEnvironment,
        *,
        local_path: Path,
        remote_path: str,
        content: str,
        executable: bool = False,
    ) -> None:
        await self._ensure_isolated_agent_user(environment)
        remote_parent = PurePosixPath(remote_path).parent.as_posix()
        await self.exec_as_root(
            environment,
            command=(
                f"install -d -m 0750 -o {AGENT_USER} -g {AGENT_USER} "
                f"{shlex.quote(remote_parent)}"
            ),
        )
        with tempfile.TemporaryDirectory(prefix="harbor-command-agent-") as temp_dir:
            source = Path(temp_dir) / local_path.name
            source.write_text(content, encoding="utf-8")
            source.chmod(0o700 if executable else 0o600)
            await environment.upload_file(source, remote_path)
        await self.exec_as_root(
            environment,
            command=(
                f"chown {AGENT_USER}:{AGENT_USER} {shlex.quote(remote_path)} && "
                f"chmod {'0700' if executable else '0600'} "
                f"{shlex.quote(remote_path)}"
            ),
        )

    async def _command_body(
        self,
        environment: BaseEnvironment,
        spec: CommandSpec,
        *,
        phase: Literal["setup", "run"],
    ) -> str:
        if spec.argv is not None:
            return shlex.join(spec.argv)
        if spec.script is None:
            raise RuntimeError("Validated command has no argv or script")
        relative = Path("command-agent") / f"{phase}.sh"
        remote_path = f"{_LOGS_PATH}/{relative.as_posix()}"
        await self._stage_text(
            environment,
            local_path=self.logs_dir / relative,
            remote_path=remote_path,
            content=spec.script,
            executable=True,
        )
        return f"/bin/bash {shlex.quote(remote_path)}"

    def _binding_values(
        self,
        spec: CommandSpec,
        *,
        model_connection: dict[CommandBinding, str] | None = None,
    ) -> dict[str, str]:
        values: dict[CommandBinding, str | None] = {
            "instruction_path": _INSTRUCTION_PATH,
            "workspace_path": _WORKSPACE_PATH,
            "logs_path": _LOGS_PATH,
            "agent_home": AGENT_HOME,
            "model_name": self.model_name,
            "model_base_url": None,
            "model_api_key": None,
            "agent_version": self.version() or "unknown",
        }
        if model_connection is not None:
            values.update(model_connection)
        env: dict[str, str] = {}
        env.update(spec.literals)
        for name, binding in spec.bindings.items():
            value = values[binding]
            if value is None:
                raise RuntimeError(f"Binding {binding!r} is unavailable")
            env[name] = value
        return env

    async def _execute(
        self,
        environment: BaseEnvironment,
        spec: CommandSpec,
        *,
        phase: Literal["setup", "run"],
        model_connection: dict[CommandBinding, str] | None = None,
    ) -> None:
        await self._ensure_isolated_agent_user(environment)
        body = await self._command_body(environment, spec, phase=phase)
        log_path = f"{_LOGS_PATH}/{phase}.log"
        command = (
            "set -o pipefail; "
            f"{{ {body}; }} 2>&1 | stdbuf -oL tee {shlex.quote(log_path)}"
        )
        await self.exec_as_agent_clean(
            environment,
            command=command,
            env=self._binding_values(spec, model_connection=model_connection),
            cwd=_WORKSPACE_PATH,
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if self.command_config.setup is not None:
            await self._execute(
                environment,
                self.command_config.setup,
                phase="setup",
            )

    def _uses_model_connection(self) -> bool:
        return any(
            binding in {"model_base_url", "model_api_key"}
            for binding in self.command_config.run.bindings.values()
        )

    def _prepare_model_connection(self) -> dict[CommandBinding, str] | None:
        if not self._uses_model_connection():
            return None
        if self.model_name is None:
            raise ValueError("Model bindings require model_name")
        base_url = self._get_env("OPENAI_BASE_URL")
        api_key = self._get_env("OPENAI_API_KEY")
        if not base_url or not api_key:
            raise RuntimeError("Command agent requires direct model settings")
        return {
            "model_base_url": base_url,
            "model_api_key": api_key,
        }

    async def _download_atif(
        self,
        environment: BaseEnvironment,
        declared: AtifOutput,
    ) -> Trajectory:
        remote_path = f"{_LOGS_PATH}/{declared.path}"
        with tempfile.TemporaryDirectory(
            prefix="harbor-command-agent-atif-"
        ) as temp_dir:
            downloaded = Path(temp_dir) / "trajectory.json"
            try:
                await environment.download_file(remote_path, downloaded)
            except Exception as error:
                raise RuntimeError(
                    f"Declared ATIF output was not produced: {declared.path}"
                ) from error
            try:
                if downloaded.stat().st_size > _MAX_ATIF_BYTES:
                    raise ValueError("ATIF output exceeds the size limit")
                trajectory = Trajectory.model_validate_json(downloaded.read_text())
            except (OSError, UnicodeError, ValueError) as error:
                raise RuntimeError(
                    f"Declared ATIF output is invalid: {declared.path}"
                ) from error
        return trajectory

    async def _download_output(
        self,
        environment: BaseEnvironment,
        declared: DeclaredOutput,
    ) -> None:
        remote_path = f"{_LOGS_PATH}/{declared.path}"
        destination = self.logs_dir / declared.path
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=destination.parent,
            prefix=f".{destination.name}-",
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            try:
                await environment.download_file(remote_path, temporary)
            except Exception as error:
                raise RuntimeError(
                    f"Declared output was not produced: {declared.path}"
                ) from error
            if temporary.stat().st_size > _MAX_OUTPUT_BYTES:
                raise RuntimeError(
                    f"Declared output exceeds the size limit: {declared.path}"
                )
            os.replace(temporary, destination)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    async def _collect_outputs(self, environment: BaseEnvironment) -> None:
        for declared in self.command_config.outputs:
            await self._download_output(environment, declared)

    def _write_canonical_atif(self, trajectory: Trajectory) -> None:
        canonical = self.logs_dir / "trajectory.json"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.logs_dir,
            prefix=".trajectory-",
            suffix=".json",
            text=True,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(format_trajectory_json(trajectory.to_json_dict()) + "\n")
            os.replace(temporary_name, canonical)
        except BaseException:
            Path(temporary_name).unlink(missing_ok=True)
            raise

    @staticmethod
    def _ingest_atif_metrics(
        trajectory: Trajectory,
        context: AgentContext,
    ) -> None:
        metrics = trajectory.final_metrics
        if metrics is None:
            return
        if metrics.total_prompt_tokens is not None:
            context.n_input_tokens = metrics.total_prompt_tokens
        if metrics.total_completion_tokens is not None:
            context.n_output_tokens = metrics.total_completion_tokens
        if metrics.total_cached_tokens is not None:
            context.n_cache_tokens = metrics.total_cached_tokens
        if metrics.total_cost_usd is not None:
            context.cost_usd = metrics.total_cost_usd

    async def _ingest_atif(
        self,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        declared = self.command_config.atif
        if declared is None:
            return
        trajectory = await self._download_atif(environment, declared)
        self._write_canonical_atif(trajectory)
        self._ingest_atif_metrics(trajectory, context)

    async def _run_command(self, environment: BaseEnvironment) -> None:
        model_connection = self._prepare_model_connection()
        await self._execute(
            environment,
            self.command_config.run,
            phase="run",
            model_connection=model_connection,
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._stage_text(
            environment,
            local_path=self.logs_dir / "instruction.txt",
            remote_path=_INSTRUCTION_PATH,
            content=instruction,
        )
        await self._run_command(environment)
        await self._collect_outputs(environment)
        await self._ingest_atif(environment, context)

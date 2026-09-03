"""Direct OpenAI-compatible inference configuration for Harbor agents."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any, ClassVar, TypeVar, cast

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.support.control_job_environment import ControlJobEnvironment
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent

_AgentT = TypeVar("_AgentT")
_RunMethod = Callable[[_AgentT, str, BaseEnvironment, AgentContext], Awaitable[None]]
MAX_OUTPUT_TOKENS_ENV = "HARBOR_HF_MAX_OUTPUT_TOKENS"


def allowed_model_id(model_name: str | None) -> str:
    """Return the Harbor model id after its provider prefix."""
    if not model_name or "/" not in model_name:
        raise ValueError("Model name must be in the format provider/model_name")
    return model_name.split("/", 1)[1]


def max_output_tokens(raw: str | None) -> int:
    """Parse the positive output-token setting supplied by the Harbor profile."""
    if raw is None:
        raise RuntimeError(f"{MAX_OUTPUT_TOKENS_ENV} is required for inference")
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(
            f"{MAX_OUTPUT_TOKENS_ENV} must be a positive integer"
        ) from error
    if value <= 0:
        raise RuntimeError(f"{MAX_OUTPUT_TOKENS_ENV} must be a positive integer")
    return value


def with_agent_environment_cleanup(method: _RunMethod) -> _RunMethod:
    """Quiesce the task environment before Harbor advances to verification."""

    @wraps(method)
    async def wrapped(
        agent: _AgentT,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        try:
            await method(agent, instruction, environment, context)
        finally:
            if isinstance(environment, ControlJobEnvironment):
                await environment.quiesce()

    return cast("_RunMethod", wrapped)


class DirectChatCompletionsAgent(IsolatedProviderAgent):
    """Inject direct, profile-resolved inference settings into an installed agent."""

    base_url_key: ClassVar[str]
    api_key_key: ClassVar[str]
    agent_label: ClassVar[str]
    install_packages: ClassVar[tuple[str, ...]] = (
        "ca-certificates",
        "curl",
        "passwd",
        "util-linux",
    )
    install_environment: ClassVar[tuple[tuple[str, str], ...]] = ()
    inject_environment_into_process: ClassVar[bool] = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:  # noqa: ANN401 -- Harbor API
        super().__init__(*args, **kwargs)
        self._inference_env: dict[str, str] | None = None
        self._active_install_environment: dict[str, str] | None = None

    def _resolved_install_environment(self) -> dict[str, str]:
        resolved: dict[str, str] = {}
        for name, value in self.install_environment:
            if name in resolved:
                raise RuntimeError(f"duplicate install environment key: {name}")
            resolved[name] = value
        return resolved

    def allowed_model_id(self) -> str:
        """Return the profile-resolved provider model."""
        return allowed_model_id(self.model_name)

    def extend_inference_env(self, env: dict[str, str]) -> None:
        """Add harness-specific aliases to the direct inference environment."""

    async def after_inference_prepared(self) -> None:
        """Run a hook after direct inference settings are stored on the agent."""

    async def prepare_inference_env(self) -> dict[str, str]:
        """Resolve direct inference settings supplied through Harbor AgentConfig.env."""
        base_url = self._get_env(self.base_url_key) or self._get_env("OPENAI_BASE_URL")
        api_key = self._get_env(self.api_key_key) or self._get_env("OPENAI_API_KEY")
        if not base_url:
            raise RuntimeError(f"{self.agent_label} requires an inference base URL")
        if not api_key:
            raise RuntimeError(f"{self.agent_label} requires an inference API key")
        env = {
            self.base_url_key: base_url,
            self.api_key_key: api_key,
        }
        output_limit = self._get_env(MAX_OUTPUT_TOKENS_ENV)
        if output_limit:
            env[MAX_OUTPUT_TOKENS_ENV] = str(max_output_tokens(output_limit))
        self.extend_inference_env(env)
        return env

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:  # noqa: ANN401 -- Harbor API
        merged = dict(env or {})
        if self._active_install_environment is not None:
            merged.update(self._active_install_environment)
        if self._inference_env is not None:
            merged.update(self._inference_env)
        return await super().exec_as_agent(
            environment,
            command,
            env=merged,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

    async def install_runtime_packages(self, environment: BaseEnvironment) -> None:
        """Install the apt packages the isolated agent user needs."""
        packages = " ".join(self.install_packages)
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y --no-install-recommends "
                f"{packages}"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    async def install(self, environment: BaseEnvironment) -> None:
        if self._active_install_environment is not None:
            raise RuntimeError("agent installation is already active")
        self._active_install_environment = self._resolved_install_environment()
        try:
            await self.install_runtime_packages(environment)
            await super().install(environment)
        finally:
            self._active_install_environment = None

    @with_agent_environment_cleanup
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._inference_env = await self.prepare_inference_env()
        try:
            await self.after_inference_prepared()
            if not self.inject_environment_into_process:
                await super().run(instruction, environment, context)
                return
            previous: dict[str, str | None] = {}
            for key, value in self._inference_env.items():
                previous[key] = os.environ.get(key)
                os.environ[key] = value
            try:
                await super().run(instruction, environment, context)
            finally:
                for key, old in previous.items():
                    if old is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = old
        finally:
            self._inference_env = None

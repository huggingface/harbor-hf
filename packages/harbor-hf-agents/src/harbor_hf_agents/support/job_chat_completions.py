"""Shared Chat Completions loopback wrapper for Harbor installed agents."""

from __future__ import annotations

import os
from typing import Any, ClassVar

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent
from harbor_hf_agents.support.job_inference_route import (
    use_job_inference_route,
    with_job_inference_bridge_cleanup,
)


def _environment_value(name: str) -> str | None:
    try:
        return os.environ[name]
    except KeyError:
        return None


def allowed_model_id(model_name: str | None) -> str:
    """Return the Harbor model id after the provider prefix."""
    if not model_name or "/" not in model_name:
        raise ValueError("Model name must be in the format provider/model_name")
    return model_name.split("/", 1)[1]


def inference_max_output_tokens(raw: str | None) -> int:
    """Parse the positive output-token limit locked for this execution Job."""
    name = "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS"
    if raw is None:
        raise RuntimeError(f"{name} is required for Job inference")
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


class JobChatCompletionsAgent(IsolatedProviderAgent):
    """Inject the locked Job Chat Completions route into an installed agent."""

    route_base_url_key: ClassVar[str]
    route_api_key_key: ClassVar[str]
    route_label: ClassVar[str]
    install_packages: ClassVar[tuple[str, ...]] = (
        "ca-certificates",
        "curl",
        "passwd",
        "util-linux",
    )
    install_environment: ClassVar[tuple[tuple[str, str], ...]] = ()
    inject_route_into_process: ClassVar[bool] = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:  # noqa: ANN401 -- Harbor API
        super().__init__(*args, **kwargs)
        self._route_env: dict[str, str] | None = None
        self._active_install_environment: dict[str, str] | None = None

    def _resolved_install_environment(self) -> dict[str, str]:
        resolved: dict[str, str] = {}
        for name, value in self.install_environment:
            if name in resolved:
                raise RuntimeError(f"duplicate install environment key: {name}")
            resolved[name] = value
        return resolved

    def allowed_model_id(self) -> str:
        """Return the locked model id after the provider prefix."""
        return allowed_model_id(self.model_name)

    def extend_route_env(self, env: dict[str, str]) -> None:
        """Add harness-specific aliases to the loaded loopback environment."""

    async def after_route_prepared(self) -> None:
        """Run a hook after the route is stored on the agent."""

    async def prepare_route_env(self, environment: BaseEnvironment) -> dict[str, str]:
        """Load the Job loopback route and fail if it is missing."""
        env: dict[str, str] = {}
        bridged = await use_job_inference_route(
            self,
            environment,
            env,
            base_url_key=self.route_base_url_key,
            api_key_key=self.route_api_key_key,
            api="chat-completions",
            allowed_model=self.allowed_model_id(),
        )
        if not bridged:
            raise RuntimeError(f"{self.route_label} requires the Job inference route")
        if self.route_base_url_key not in env or self.route_api_key_key not in env:
            raise RuntimeError(
                f"Job inference route did not provide {self.route_label} credentials"
            )
        self.extend_route_env(env)
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
        if self._route_env is not None:
            merged.update(self._route_env)
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

    @with_job_inference_bridge_cleanup
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._route_env = await self.prepare_route_env(environment)
        await self.after_route_prepared()
        try:
            if not self.inject_route_into_process:
                await super().run(instruction, environment, context)
                return
            previous: dict[str, str | None] = {}
            for key, value in self._route_env.items():
                previous[key] = _environment_value(key)
                os.environ[key] = value
            try:
                await super().run(instruction, environment, context)
            finally:
                for key, old in previous.items():
                    if old is None:
                        del os.environ[key]
                    else:
                        os.environ[key] = old
        finally:
            self._route_env = None

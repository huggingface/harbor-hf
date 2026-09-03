"""Terminus 2 using Harbor's direct model connection."""

import asyncio
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.terminus_2 import Terminus2
from harbor.agents.terminus_2.tmux_session import TmuxSession
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from harbor_hf_agents.support.control_job_environment import ControlJobEnvironment
from harbor_hf_agents.support.direct_inference import (
    with_agent_environment_cleanup,
)


class _JobTmuxSession(TmuxSession):
    """Start tmux without waiting for PRoot's long-lived server process."""

    _READY_TIMEOUT_SECONDS = 30
    _READY_POLL_SECONDS = 0.1

    @override
    async def start(self) -> None:
        await self._attempt_tmux_installation()
        if not isinstance(self.environment, ControlJobEnvironment):
            raise RuntimeError("Terminus requires the controlled Job environment")
        await self.environment.start_background(
            command=self._tmux_start_session,
            user=self._user,
        )
        try:
            async with asyncio.timeout(self._READY_TIMEOUT_SECONDS):
                while True:
                    ready = await self.environment.exec(
                        command=(
                            f"tmux has-session -t {shlex.quote(self._session_name)}"
                        ),
                        user=self._user,
                        timeout_sec=5,
                    )
                    if ready.return_code == 0:
                        break
                    await asyncio.sleep(self._READY_POLL_SECONDS)
        except TimeoutError as error:
            raise RuntimeError(
                "tmux session did not become ready within "
                f"{self._READY_TIMEOUT_SECONDS} seconds"
            ) from error

        history_limit = 10_000_000
        set_history_result = await self.environment.exec(
            command=f"tmux set-option -g history-limit {history_limit}",
            user=self._user,
        )
        if set_history_result.return_code != 0:
            self._logger.debug(
                "Failed to increase tmux history-limit: %s",
                (set_history_result.stderr or "").strip(),
            )

        if self._remote_asciinema_recording_path:
            self._logger.debug("Starting recording.")
            await self.send_keys(
                keys=[
                    f"asciinema rec --stdin {self._remote_asciinema_recording_path}",
                    "Enter",
                ],
                min_timeout_sec=1.0,
            )
            await self.send_keys(keys=["clear", "Enter"])
            await self.environment.upload_file(
                source_path=self._GET_ASCIINEMA_TIMESTAMP_SCRIPT_HOST_PATH,
                target_path=str(self.GET_ASCIINEMA_TIMESTAMP_SCRIPT_CONTAINER_PATH),
            )


class TerminusAgent(Terminus2):
    """Run pinned Terminus 2 with direct OpenAI-compatible settings."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *,
        extra_env: dict[str, str] | None = None,
        api_base: str | None = None,
        llm_kwargs: dict[str, Any] | None = None,
        **kwargs: Any,  # noqa: ANN401 -- Harbor API
    ) -> None:
        agent_environment = dict(extra_env or {})
        resolved_base = api_base or agent_environment.get("OPENAI_BASE_URL")
        resolved_key = agent_environment.get("OPENAI_API_KEY")
        if not resolved_base or not resolved_key:
            raise ValueError("Terminus requires direct OpenAI inference settings")
        resolved_llm_kwargs = dict(llm_kwargs or {})
        resolved_llm_kwargs["api_key"] = resolved_key
        super().__init__(
            logs_dir=logs_dir,
            model_name=model_name,
            extra_env=agent_environment,
            api_base=resolved_base,
            llm_kwargs=resolved_llm_kwargs,
            **kwargs,
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        if self._record_terminal_session:
            local_recording_path = environment.trial_paths.agent_dir / "recording.cast"
            remote_recording_path: Path | PurePosixPath | None = (
                EnvironmentPaths.agent_dir / "recording.cast"
            )
        else:
            local_recording_path = None
            remote_recording_path = None

        self._session = _JobTmuxSession(
            session_name=self.name(),
            environment=environment,
            logging_path=EnvironmentPaths.agent_dir / "terminus_2.pane",
            local_asciinema_recording_path=local_recording_path,
            remote_asciinema_recording_path=remote_recording_path,
            pane_width=self._tmux_pane_width,
            pane_height=self._tmux_pane_height,
            extra_env=self._extra_env,
            user=environment.default_user,
        )
        await self._session.start()

    @override
    @with_agent_environment_cleanup
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await super().run(instruction, environment, context)

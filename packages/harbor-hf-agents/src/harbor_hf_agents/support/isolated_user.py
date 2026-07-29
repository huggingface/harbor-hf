"""Run provider agents under a dedicated unprivileged sandbox account."""

from __future__ import annotations

import shlex
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment

_AGENT_USER = "harbor-agent"
_AGENT_HOME = "/tmp/harbor-agent-home"


class IsolatedProviderAgent(BaseInstalledAgent):
    """Base class that keeps agent processes separate from root-owned ingress."""

    async def _ensure_isolated_agent_user(self, environment: BaseEnvironment) -> None:
        if getattr(self, "_isolated_agent_user_ready", False):
            return
        await super().exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"if ! id -u {_AGENT_USER} >/dev/null 2>&1; then "
                f"useradd --create-home --home-dir {_AGENT_HOME} "
                f"--shell /bin/bash {_AGENT_USER}; fi; "
                f"install -d -m 0750 -o {_AGENT_USER} -g {_AGENT_USER} "
                f"{_AGENT_HOME} /logs/agent; "
                f"chown -R {_AGENT_USER}:{_AGENT_USER} "
                f"/app /logs/agent {_AGENT_HOME}"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        self._isolated_agent_user_ready = True

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:  # noqa: ANN401 -- Harbor API
        await self._ensure_isolated_agent_user(environment)
        wrapped = (
            f"runuser -u {_AGENT_USER} -- env "
            f"HOME={shlex.quote(_AGENT_HOME)} "
            f"NVM_DIR={shlex.quote(_AGENT_HOME + '/.nvm')} "
            f"USER={_AGENT_USER} LOGNAME={_AGENT_USER} "
            f"/bin/bash -lc {shlex.quote(command)}"
        )
        return await super().exec_as_root(
            environment,
            command=wrapped,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

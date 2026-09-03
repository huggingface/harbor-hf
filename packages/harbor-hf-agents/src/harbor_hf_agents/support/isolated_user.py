"""Run provider agents under a dedicated unprivileged task account."""

from __future__ import annotations

import shlex
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment

AGENT_USER = "harbor-agent"
AGENT_HOME = "/tmp/harbor-agent-home"
_CLEAN_AGENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class IsolatedProviderAgent(BaseInstalledAgent):
    """Base class that keeps agent processes separate from root-owned ingress."""

    async def _ensure_isolated_agent_user(self, environment: BaseEnvironment) -> None:
        if getattr(self, "_isolated_agent_user_ready", False):
            return
        await super().exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"if ! id -u {AGENT_USER} >/dev/null 2>&1; then "
                f"useradd --create-home --home-dir {AGENT_HOME} "
                f"--shell /bin/bash {AGENT_USER}; fi; "
                f"install -d -m 0750 -o {AGENT_USER} -g {AGENT_USER} "
                f"{AGENT_HOME} /logs/agent /app; "
                f"chown -R {AGENT_USER}:{AGENT_USER} "
                f"/app /logs/agent {AGENT_HOME}; "
                "if [ -d /app/data ]; then "
                "chown -R root:root /app/data; "
                "chmod -R a+rX,a-w /app/data; "
                "chown root:root /app; "
                "chmod 1777 /app; "
                "fi"
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
            f"runuser -u {AGENT_USER} -- env "
            f"HOME={shlex.quote(AGENT_HOME)} "
            f"NVM_DIR={shlex.quote(AGENT_HOME + '/.nvm')} "
            f"USER={AGENT_USER} LOGNAME={AGENT_USER} "
            f"/bin/bash -lc {shlex.quote(command)}"
        )
        return await super().exec_as_root(
            environment,
            command=wrapped,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

    async def exec_as_agent_clean(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:  # noqa: ANN401 -- Harbor API
        """Run with only fixed account state and explicitly forwarded variables."""
        await self._ensure_isolated_agent_user(environment)
        forwarded = " ".join(f'{name}="${{{name}}}"' for name in sorted(env or {}))
        if forwarded:
            forwarded += " "
        wrapped = (
            f"runuser -u {AGENT_USER} -- env -i "
            f"HOME={shlex.quote(AGENT_HOME)} "
            f"NVM_DIR={shlex.quote(AGENT_HOME + '/.nvm')} "
            f"USER={AGENT_USER} LOGNAME={AGENT_USER} "
            f"PATH={shlex.quote(_CLEAN_AGENT_PATH)} "
            f"{forwarded}"
            f"/bin/bash -lc {shlex.quote(command)}"
        )
        return await super().exec_as_root(
            environment,
            command=wrapped,
            env=dict(env or {}),
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

"""Run Pi with the bundled Pi Code Mode extension."""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import override

from harbor.environments.base import BaseEnvironment

from harbor_hf_agents.pi.agent import PiAgent

_LOCAL_PACKAGE = Path("/opt/harbor-hf/pi-code-mode/pi-code-mode.tgz")
_REMOTE_PACKAGE = "/tmp/harbor-pi-code-mode.tgz"
_REMOTE_PACKAGE_DIR = "/tmp/harbor-pi-code-mode"
_REMOTE_PI_AGENT_DIR = "/tmp/harbor-pi-agent"
_REMOTE_CONFIG_DIR = "$HOME/.config/pi-code-mode"
_CODE_MODE_CONFIG = '{"mode":"codex"}'


class PiCodeModeAgent(PiAgent):
    """Install the reviewed Code Mode package before Harbor runs Pi."""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        if not _LOCAL_PACKAGE.is_file():
            raise RuntimeError("the parent image does not contain Pi Code Mode")

        await self._upload_agent_owned_file(
            environment,
            _LOCAL_PACKAGE,
            _REMOTE_PACKAGE,
        )
        package = shlex.quote(_REMOTE_PACKAGE)
        package_dir = shlex.quote(_REMOTE_PACKAGE_DIR)
        config = shlex.quote(_CODE_MODE_CONFIG)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                ". ~/.nvm/nvm.sh; "
                f"rm -rf {package_dir}; "
                f"mkdir -p {package_dir}; "
                f"tar -xzf {package} -C {package_dir} --strip-components=1; "
                f"test -x {package_dir}/dist/runtime/linux-x64/pi-code-mode-host; "
                f"mkdir -p {_REMOTE_CONFIG_DIR}; "
                f"printf '%s\\n' {config} > {_REMOTE_CONFIG_DIR}/config.json; "
                f"chmod 600 {_REMOTE_CONFIG_DIR}/config.json; "
                f"PI_CODING_AGENT_DIR={_REMOTE_PI_AGENT_DIR} pi install "
                f"{package_dir}; "
                f"PI_CODING_AGENT_DIR={_REMOTE_PI_AGENT_DIR} pi list; "
                "pi --version"
            ),
        )

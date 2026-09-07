from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from harbor_hf_agents.pi.agent import PiAgent
from harbor_hf_agents.pi_code_mode import agent as code_mode_module
from harbor_hf_agents.pi_code_mode.agent import PiCodeModeAgent


@pytest.mark.asyncio
async def test_installs_bundled_code_mode_package(tmp_path, monkeypatch) -> None:
    package = tmp_path / "pi-code-mode.tgz"
    package.write_bytes(b"test package")
    base_install = AsyncMock()
    monkeypatch.setattr(PiAgent, "install", base_install)
    monkeypatch.setattr(code_mode_module, "_LOCAL_PACKAGE", package)
    environment = AsyncMock()
    environment.default_user = "agent"
    environment.exec.return_value = SimpleNamespace(
        return_code=0,
        stdout="",
        stderr="",
    )
    agent = PiCodeModeAgent(logs_dir=tmp_path / "logs")

    await agent.install(environment)

    base_install.assert_awaited_once_with(environment)
    environment.upload_file.assert_awaited_once_with(
        package,
        "/tmp/harbor-pi-code-mode.tgz",
    )
    command = environment.exec.call_args_list[-1].kwargs["command"]
    assert "dist/runtime/linux-x64/pi-code-mode-host" in command
    assert (
        "PI_CODING_AGENT_DIR=/tmp/harbor-pi-agent pi install /tmp/harbor-pi-code-mode"
    ) in command
    assert "; pi install /tmp/harbor-pi-code-mode; " in command
    assert "PI_CODING_AGENT_DIR=/tmp/harbor-pi-agent pi list" in command
    assert "; pi list; " in command
    assert "$HOME/.pi/agent" not in command
    assert '{"mode":"codex"}' in command


@pytest.mark.asyncio
async def test_stops_when_parent_image_omits_code_mode(tmp_path, monkeypatch) -> None:
    base_install = AsyncMock()
    monkeypatch.setattr(PiAgent, "install", base_install)
    monkeypatch.setattr(
        code_mode_module,
        "_LOCAL_PACKAGE",
        tmp_path / "missing.tgz",
    )
    agent = PiCodeModeAgent(logs_dir=tmp_path / "logs")

    with pytest.raises(RuntimeError, match="does not contain Pi Code Mode"):
        await agent.install(AsyncMock())

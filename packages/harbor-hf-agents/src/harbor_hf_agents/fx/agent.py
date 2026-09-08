"""FX adapter that preserves the locked Hugging Face model route."""

from __future__ import annotations

import json
import os
import shlex
from typing import override

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.fx import Fx
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.support.fx_inference_bridge import (
    start_fx_bridge,
    stop_fx_bridge,
)
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent

_FX_RELEASE_CHECKSUMS: dict[tuple[str, str], str] = {
    (
        "0.0.5",
        "x86_64",
    ): "d5639d173267774aa8228a474baf619a7076ac41a91023915007c865143429b1",
    (
        "0.0.5",
        "aarch64",
    ): "8bbcde6a41256c4fac4e0a022291cf02740419e27afabde3b8f45e7a4e393edb",
    (
        "0.0.6",
        "x86_64",
    ): "120fa992df8caf982e17ca9e9e3966c790b0d150480511eaf51392e66a0f0b84",
    (
        "0.0.6",
        "aarch64",
    ): "0dfd53224c5ecede601bb8ce649f84fab6db05a39afbcd5b39e6091833f6c4d7",
}
_ROUTER_ENV = "OPENAI_BASE_URL"
_LOCAL_GATEWAY_BASE = "http://127.0.0.1"
_LOCAL_GATEWAY_CHAT = f"{_LOCAL_GATEWAY_BASE}/v3/ai/language-model"
_LOCAL_GATEWAY_API_KEY = "harbor-local-fx-bridge"


class FxAgent(IsolatedProviderAgent, Fx):
    """Run FX through a bounded local adapter for Hugging Face inference."""

    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="openai",
        api_key_envs=("OPENAI_API_KEY",),
        base_url_envs=("OPENAI_BASE_URL",),
    )

    def _model_id(self) -> str:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("FX model name must be in provider/model format")
        return self.model_name.split("/", 1)[1]

    def _release_checksum(self, architecture: str) -> str:
        version = self.version()
        if version is None:
            raise ValueError("FX version is required")
        try:
            return _FX_RELEASE_CHECKSUMS[(version, architecture)]
        except KeyError as error:
            raise ValueError(
                f"FX release {version} has no pinned Linux {architecture} artifact"
            ) from error

    async def _install_system_dependencies(
        self,
        environment: BaseEnvironment,
    ) -> None:
        dependencies = (
            "bash",
            "ca-certificates",
            "coreutils",
            "curl",
            "passwd",
            "python3",
            "tar",
            "tmux",
        )
        checks = " && ".join(
            f"command -v {shlex.quote(command)} >/dev/null 2>&1"
            for command in (
                "bash",
                "curl",
                "python3",
                "sha256sum",
                "stdbuf",
                "tar",
                "tmux",
                "useradd",
            )
        )
        packages = shlex.join(dependencies)
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"if ! ({checks}); then "
                "command -v apt-get >/dev/null 2>&1 || "
                "exit 1; "
                "apt-get -o Acquire::Check-Valid-Until=false update && "
                f"apt-get install -y --no-install-recommends {packages}; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    async def _install_release(self, environment: BaseEnvironment) -> None:
        version = self.version()
        if version is None:
            raise ValueError("FX version is required")
        archive_url = (
            "https://github.com/vercel-labs/fx/releases/download/"
            f"v{version}/fx-linux-${{fx_target}}.tar.gz"
        )
        checksum_x86 = self._release_checksum("x86_64")
        checksum_arm = self._release_checksum("aarch64")
        command = (
            "set -euo pipefail; "
            'case "$(uname -m)" in '
            "x86_64|amd64) fx_target=x86_64; fx_sha256="
            f"{checksum_x86}; "
            ";; "
            "aarch64|arm64) fx_target=aarch64; fx_sha256="
            f"{checksum_arm}; "
            ";; "
            "*) exit 1; "
            ";; esac; "
            'fx_dir="$HOME/.local/bin"; '
            'cache_dir="$HOME/.cache/harbor-fx"; '
            'archive="$cache_dir/fx-'
            f"{version}"
            '-${fx_target}.tar.gz"; '
            'mkdir -p "$fx_dir" "$cache_dir"; '
            f'curl -fsSL --retry 3 "{archive_url}" -o "$archive"; '
            'printf "%s  %s\\n" "$fx_sha256" "$archive" | '
            "sha256sum --check --strict; "
            'tar -xzf "$archive" -C "$fx_dir" fx; '
            'chmod 0755 "$fx_dir/fx"; '
            f"{self._PATH_EXPORT}; fx --version"
        )
        await self.exec_as_agent(environment, command=command)

    async def _write_agent_config(self, environment: BaseEnvironment) -> None:
        if self.options.reasoning_effort is not None:
            settings = json.dumps(
                {"effort": self.options.reasoning_effort},
                separators=(",", ":"),
            )
            await self.exec_as_agent(
                environment,
                command=(
                    f'mkdir -p "$HOME/.fx"; '
                    f"printf '%s' {shlex.quote(settings)} > "
                    '"$HOME/.fx/settings.json"; '
                    'chmod 0600 "$HOME/.fx/settings.json"'
                ),
            )
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)
        if self.mcp_servers:
            mcp_config = self._build_mcp_config()
            await self.exec_as_agent(
                environment,
                command=(
                    'mkdir -p "$HOME/.fx"; '
                    f"printf '%s' {shlex.quote(mcp_config)} > "
                    '"$HOME/.fx/mcp.json"; '
                    'chmod 0600 "$HOME/.fx/mcp.json"'
                ),
            )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self._install_system_dependencies(environment)
        await self._install_release(environment)
        await self._write_agent_config(environment)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        upstream = self._get_env(_ROUTER_ENV)
        if upstream is None:
            raise RuntimeError("FX requires the OpenAI-compatible Hugging Face route")
        try:
            inference_token = os.environ["HF_INFERENCE_TOKEN"]
        except KeyError as error:
            raise RuntimeError("HF_INFERENCE_TOKEN is required for FX") from error

        model = self._model_id()
        await start_fx_bridge(
            self,
            environment,
            upstream=upstream,
            token=inference_token,
            model=model,
        )
        try:
            permission_arg = {
                "ask": "",
                "auto": "--auto ",
                "yolo": "--yolo ",
            }[self.options.permission_mode or "yolo"]
            output_path = "/logs/agent/fx.json"
            await self.exec_as_agent(
                environment,
                command=(
                    f"{self._PATH_EXPORT}; "
                    f"fx ask {permission_arg}--json -- "
                    f"{shlex.quote(instruction)} < /dev/null | "
                    f"stdbuf -oL tee {shlex.quote(output_path)}"
                ),
                env={
                    "AI_GATEWAY_API_KEY": _LOCAL_GATEWAY_API_KEY,
                    "FX_AUTO_UPGRADE": "0",
                    "FX_GATEWAY_BASE_URL": _LOCAL_GATEWAY_BASE,
                    "FX_GATEWAY_CHAT_URL": _LOCAL_GATEWAY_CHAT,
                    "FX_MODEL": model,
                    "FX_SOUND": "0",
                    "OPENAI_API_KEY": _LOCAL_GATEWAY_API_KEY,
                    "OPENAI_BASE_URL": f"{_LOCAL_GATEWAY_BASE}/v1",
                    "VERCEL_AI_GATEWAY_API_KEY": _LOCAL_GATEWAY_API_KEY,
                },
            )
        finally:
            usage = await stop_fx_bridge(self, environment)
            if usage is not None:
                context.n_input_tokens = usage.input_tokens
                context.n_output_tokens = usage.output_tokens

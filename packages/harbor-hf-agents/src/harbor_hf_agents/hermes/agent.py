from __future__ import annotations

import hashlib
import json
import re
import shlex
from typing import Any, ClassVar, Literal, cast, override

import yaml
from harbor.agents.installed.base import CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json
from pydantic import BaseModel, ConfigDict, Field

from harbor_hf_agents.support.hf_inference_bridge import (
    prepare_hf_inference_bridge,
    stop_hf_inference_bridge,
)
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent

# Hermes native provider routing.
# Maps Harbor provider prefix → (hermes --provider CLI flag, env var names).
# None for provider flag means use full provider/model format without --provider.
# Providers not in this map route through OpenRouter.
_NATIVE_PROVIDERS: dict[str, tuple[str | None, list[str]]] = {
    "anthropic": ("anthropic", ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"]),
    "openai": (None, ["OPENAI_API_KEY"]),
    "zai": ("zai", ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"]),
    "kimi": ("kimi-coding", ["KIMI_API_KEY"]),
    "minimax": ("minimax", ["MINIMAX_API_KEY"]),
    "minimax-cn": ("minimax-cn", ["MINIMAX_CN_API_KEY"]),
}
_HERMES_COMMIT = re.compile(r"^[0-9a-fA-F]{40}$")


class _HermesConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class HermesAgentSettings(_HermesConfigModel):
    max_turns: int = Field(default=90, ge=1, le=1000)


class HermesMemorySettings(_HermesConfigModel):
    memory_enabled: bool = False
    user_profile_enabled: bool = False


class HermesCompressionSettings(_HermesConfigModel):
    enabled: bool = True
    threshold: float = Field(default=0.85, gt=0, le=1)


class HermesTerminalSettings(_HermesConfigModel):
    backend: Literal["local"] = "local"
    timeout: int = Field(default=180, ge=1, le=3600)


class HermesDelegationSettings(_HermesConfigModel):
    max_iterations: int = Field(default=50, ge=1, le=1000)


class HermesCheckpointSettings(_HermesConfigModel):
    enabled: bool = False


class HermesRuntimeConfig(_HermesConfigModel):
    """Secret-free Hermes behavior rendered into ``config.yaml``."""

    toolsets: tuple[str, ...] = Field(default=("hermes-cli",), min_length=1)
    agent: HermesAgentSettings = Field(default_factory=HermesAgentSettings)
    memory: HermesMemorySettings = Field(default_factory=HermesMemorySettings)
    compression: HermesCompressionSettings = Field(
        default_factory=HermesCompressionSettings
    )
    terminal: HermesTerminalSettings = Field(default_factory=HermesTerminalSettings)
    delegation: HermesDelegationSettings = Field(
        default_factory=HermesDelegationSettings
    )
    checkpoints: HermesCheckpointSettings = Field(
        default_factory=HermesCheckpointSettings
    )


class HermesAgent(IsolatedProviderAgent):
    """NousResearch Hermes Agent integration."""

    SUPPORTS_ATIF: bool = True

    CLI_FLAGS: ClassVar[list[CliFlag]] = []

    def __init__(
        self,
        *args: Any,  # noqa: ANN401 -- Harbor API
        provider_runtime: dict[str, Any] | None = None,
        **kwargs: Any,  # noqa: ANN401 -- Harbor API
    ) -> None:
        self._runtime_config = HermesRuntimeConfig()
        self._provider_runtime = self._validate_provider_runtime(provider_runtime)
        super().__init__(*args, **kwargs)

    @staticmethod
    def _validate_provider_runtime(value: dict[str, Any] | None) -> dict[str, Any]:
        if value is None:
            return {
                "api": "chat-completions",
                "timeout_seconds": 60.0,
                "max_attempts": 1,
            }
        if set(value) != {"api", "timeout_seconds", "max_attempts"}:
            raise ValueError("provider_runtime has unknown or missing fields")
        if value["api"] != "chat-completions":
            raise ValueError("Hermes requires the chat-completions API")
        timeout = value["timeout_seconds"]
        attempts = value["max_attempts"]
        if (
            not isinstance(timeout, (int, float))
            or isinstance(timeout, bool)
            or timeout <= 0
        ):
            raise ValueError("provider_runtime timeout must be positive")
        if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 1:
            raise ValueError("provider_runtime attempts must be positive")
        return dict(value)

    @staticmethod
    @override
    def name() -> str:
        return "hermes"

    @override
    def version(self) -> str | None:
        return self._version

    @override
    def get_version_command(self) -> str | None:
        return 'export PATH="$HOME/.local/bin:$PATH"; hermes version'

    @staticmethod
    def _installation_spec(version: str | None) -> tuple[str, str]:
        if not version or _HERMES_COMMIT.fullmatch(version) is None:
            raise ValueError("Hermes requires a full Git commit revision")
        revision = version.lower()
        return (
            "https://raw.githubusercontent.com/NousResearch/hermes-agent/"
            f"{revision}/scripts/install.sh",
            f" --commit {shlex.quote(revision)}",
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        installer_url, revision_flag = self._installation_spec(self._version)
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y --no-install-recommends "
                "curl git passwd ripgrep util-linux xz-utils"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"curl -fsSL {shlex.quote(installer_url)} | "
                f"bash -s -- --skip-setup{revision_flag} && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                'export HERMES_HOME="${HERMES_HOME:-/tmp/hermes}" && '
                'mkdir -p "$HERMES_HOME" "$HERMES_HOME/sessions" '
                '"$HERMES_HOME/skills" "$HERMES_HOME/memories" && '
                "hermes version"
            ),
        )

    # ------------------------------------------------------------------
    # Config generation
    # ------------------------------------------------------------------

    def _effective_runtime_config(self) -> HermesRuntimeConfig:
        return self._runtime_config

    @staticmethod
    def _build_config_yaml(
        model: str,
        *,
        custom_base_url: str | None = None,
        custom_api_key: str | None = None,
    ) -> str:
        """Render the fixed, secret-free Hermes ``config.yaml``."""
        config = HermesRuntimeConfig()
        value: dict[str, object] = {
            "model": model,
            "provider": "auto",
            **config.model_dump(mode="json"),
        }
        if custom_base_url is not None:
            if custom_api_key is None:
                raise ValueError("custom Hermes endpoint requires a local API key")
            value["model"] = {
                "default": model,
                "provider": "custom",
                "base_url": custom_base_url,
                "api_key": custom_api_key,
            }
            value.pop("provider")
        return yaml.safe_dump(value, default_flow_style=False, sort_keys=True)

    # ------------------------------------------------------------------
    # MCP server and skill support
    # ------------------------------------------------------------------

    def _mcp_config(self) -> dict[str, object]:
        mcp_config: dict[str, object] = {}
        for server in self.mcp_servers:
            if server.transport == "stdio":
                mcp_config[server.name] = {
                    "command": server.command,
                    "args": server.args,
                }
            else:
                mcp_config[server.name] = {"url": server.url}
        return mcp_config

    def _build_register_mcp_servers_command(self) -> str | None:
        """Append MCP server entries to Hermes's config file."""
        if not self.mcp_servers:
            return None
        yaml_str = yaml.safe_dump(
            {"mcp_servers": self._mcp_config()},
            default_flow_style=False,
            sort_keys=True,
        )
        return f"cat >> /tmp/hermes/config.yaml << 'MCPEOF'\n{yaml_str}MCPEOF"

    def _build_register_skills_command(self) -> str | None:
        if not self.skills_dir:
            return None
        return (
            "mkdir -p /tmp/hermes/skills && "
            f"cp -r {shlex.quote(self.skills_dir)}/* /tmp/hermes/skills/ "
            "2>/dev/null || true"
        )

    # ------------------------------------------------------------------
    # ATIF trajectory conversion
    # ------------------------------------------------------------------

    @staticmethod
    def _content_text(content: object) -> str:
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            value = part.get("text") or part.get("content")
            if isinstance(value, str):
                parts.append(value)
        return " ".join(parts)

    @staticmethod
    def _arguments(value: object) -> dict[str, Any]:
        if isinstance(value, dict):
            return cast(dict[str, Any], value)
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                return {"raw": value}
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        return {}

    @staticmethod
    def _integer(value: object) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    @classmethod
    def _message_metrics(cls, usage: object) -> Metrics | None:
        if not isinstance(usage, dict):
            return None
        prompt = cls._integer(usage.get("prompt_tokens") or usage.get("input"))
        completion = cls._integer(usage.get("completion_tokens") or usage.get("output"))
        cached = cls._integer(usage.get("cache_read_tokens") or usage.get("cacheRead"))
        cache_write = cls._integer(
            usage.get("cache_write_tokens") or usage.get("cacheWrite")
        )
        if not (prompt or completion or cached or cache_write):
            return None
        return Metrics(
            prompt_tokens=prompt + cached or None,
            completion_tokens=completion or None,
            cached_tokens=cached or None,
            extra={"cache_write_tokens": cache_write} if cache_write else None,
        )

    @staticmethod
    def _load_sessions(jsonl_text: str) -> list[dict[str, Any]]:
        sessions: list[dict[str, Any]] = []
        loose_messages: list[dict[str, Any]] = []
        # Split only on LF so literal Unicode line separators remain in messages.
        for raw_line in jsonl_text.split("\n"):
            line = raw_line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            if isinstance(value.get("messages"), list):
                sessions.append(value)
            elif isinstance(value.get("role"), str):
                loose_messages.append(value)
        if loose_messages:
            sessions.append({"messages": loose_messages})
        return sessions

    def _select_session(self, sessions: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not sessions:
            return None
        expected = {self.model_name}
        if self.model_name and "/" in self.model_name:
            expected.add(self.model_name.split("/", 1)[1])
        for session in reversed(sessions):
            observed = {session.get("model")}
            observed.update(
                message.get("model")
                for message in session.get("messages", [])
                if isinstance(message, dict)
            )
            if expected & {value for value in observed if isinstance(value, str)}:
                return session
        return sessions[-1]

    def _convert_hermes_session_to_atif(  # noqa: C901 -- parser branches
        self, jsonl_text: str, session_id: str
    ) -> Trajectory | None:
        """Convert redacted Hermes session exports to ATIF-v1.7."""
        sessions = self._load_sessions(jsonl_text)
        session = self._select_session(sessions)
        if session is None:
            return None
        messages = [
            item for item in session.get("messages", []) if isinstance(item, dict)
        ]
        if not messages:
            return None

        steps: list[Step] = []
        prompt_total = 0
        completion_total = 0
        cached_total = 0
        index = 0
        while index < len(messages):
            message = messages[index]
            role = message.get("role")
            if role == "user":
                content = self._content_text(message.get("content"))
                if content:
                    steps.append(
                        Step(
                            step_id=len(steps) + 1,
                            source="user",
                            message=content,
                        )
                    )
                index += 1
                continue
            if role != "assistant":
                index += 1
                continue

            tool_calls: list[ToolCall] = []
            raw_tool_calls = message.get("tool_calls")
            if isinstance(raw_tool_calls, list):
                for call_index, raw_call in enumerate(raw_tool_calls, start=1):
                    if not isinstance(raw_call, dict):
                        continue
                    function = raw_call.get("function")
                    if not isinstance(function, dict):
                        continue
                    tool_calls.append(
                        ToolCall(
                            tool_call_id=str(
                                raw_call.get("id")
                                or f"hermes-{len(steps) + 1}-{call_index}"
                            ),
                            function_name=str(function.get("name") or "unknown"),
                            arguments=self._arguments(function.get("arguments")),
                        )
                    )

            observations: list[ObservationResult] = []
            cursor = index + 1
            while cursor < len(messages) and messages[cursor].get("role") == "tool":
                tool_message = messages[cursor]
                observations.append(
                    ObservationResult(
                        source_call_id=(
                            str(tool_message["tool_call_id"])
                            if tool_message.get("tool_call_id") is not None
                            else None
                        ),
                        content=self._content_text(tool_message.get("content")) or None,
                    )
                )
                cursor += 1

            content = self._content_text(message.get("content"))
            metrics = self._message_metrics(message.get("usage"))
            if metrics is not None:
                prompt_total += metrics.prompt_tokens or 0
                completion_total += metrics.completion_tokens or 0
                cached_total += metrics.cached_tokens or 0
            if content or tool_calls:
                reasoning = message.get("reasoning_content")
                steps.append(
                    Step(
                        step_id=len(steps) + 1,
                        source="agent",
                        message=content or "[tool call]",
                        model_name=self.model_name,
                        reasoning_content=(
                            reasoning if isinstance(reasoning, str) else None
                        ),
                        tool_calls=tool_calls or None,
                        observation=(
                            Observation(results=observations) if observations else None
                        ),
                        metrics=metrics,
                        llm_call_count=1,
                    )
                )
            index = cursor

        if len(steps) < 2:
            return None

        observed_models = {
            value
            for value in [
                session.get("model"),
                *[
                    message.get("model")
                    for message in messages
                    if isinstance(message.get("model"), str)
                ],
            ]
            if isinstance(value, str) and value
        }
        top_prompt = self._integer(session.get("input_tokens"))
        top_completion = self._integer(session.get("output_tokens"))
        top_cached = self._integer(session.get("cache_read_tokens"))
        selected_session_id = str(
            session.get("id") or session.get("session_id") or session_id
        )
        expected_models = {self.model_name}
        if self.model_name and "/" in self.model_name:
            expected_models.add(self.model_name.split("/", 1)[1])
        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=selected_session_id,
            agent=Agent(
                name="hermes",
                version=self.version() or "unknown",
                model_name=self.model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_steps=len(steps),
                total_prompt_tokens=top_prompt or prompt_total or None,
                total_completion_tokens=top_completion or completion_total or None,
                total_cached_tokens=top_cached or cached_total or None,
            ),
            extra={
                "native_raw_trace_file": "hermes-session.jsonl",
                "trace_fidelity": "session",
                "observed_models": sorted(observed_models),
                "canonical_model_identity": bool(observed_models)
                and observed_models <= expected_models,
                "exported_session_count": len(sessions),
                "reasoning_tokens": self._integer(session.get("reasoning_tokens")),
                "cache_write_tokens": self._integer(session.get("cache_write_tokens")),
                "api_call_count": self._integer(session.get("api_call_count")),
                "tool_call_count": self._integer(session.get("tool_call_count")),
            },
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        session_path = self.logs_dir / "hermes-session.jsonl"
        if not session_path.exists():
            return
        jsonl_text = session_path.read_text(encoding="utf-8", errors="replace")
        fallback_session_id = (
            "hermes-" + hashlib.sha256(jsonl_text.encode()).hexdigest()[:16]
        )
        try:
            trajectory = self._convert_hermes_session_to_atif(
                jsonl_text, fallback_session_id
            )
        except Exception as exc:
            self.logger.debug("Error converting Hermes session to ATIF: %s", exc)
            return
        if trajectory is None:
            return
        try:
            atif_path = self.logs_dir / "trajectory.json"
            atif_path.write_text(
                format_trajectory_json(trajectory.to_json_dict()) + "\n",
                encoding="utf-8",
            )
            if trajectory.final_metrics:
                context.n_input_tokens = (
                    trajectory.final_metrics.total_prompt_tokens or 0
                )
                context.n_output_tokens = (
                    trajectory.final_metrics.total_completion_tokens or 0
                )
        except Exception as exc:
            self.logger.debug("Error writing Hermes ATIF trajectory: %s", exc)

    # ------------------------------------------------------------------
    # Agent commands
    # ------------------------------------------------------------------

    @with_prompt_template
    async def run(  # noqa: C901 -- parser branches
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, model = self.model_name.split("/", 1)
        env: dict[str, str] = {
            "HERMES_HOME": "/tmp/hermes",
            "TERMINAL_ENV": "local",
        }

        hermes_provider_flag: str | None = None
        use_native = False
        if provider in _NATIVE_PROVIDERS:
            native_flag, key_names = _NATIVE_PROVIDERS[provider]
            for key_name in key_names:
                key_value = self._get_env(key_name)
                if key_value:
                    env[key_name] = key_value
                    hermes_provider_flag = native_flag
                    use_native = True
                    break
            if use_native and provider == "openai":
                base_url = self._get_env("OPENAI_BASE_URL")
                if base_url:
                    env["OPENAI_BASE_URL"] = base_url

        if not use_native:
            openrouter_key = self._get_env("OPENROUTER_API_KEY")
            if not openrouter_key:
                native_info = _NATIVE_PROVIDERS.get(provider)
                if native_info:
                    key_hint = " or ".join(native_info[1])
                    raise ValueError(
                        f"No API key found. Set {key_hint} or OPENROUTER_API_KEY."
                    )
                raise ValueError("No API key found. Set OPENROUTER_API_KEY.")
            env["OPENROUTER_API_KEY"] = openrouter_key

        bridged = False
        if use_native and provider == "openai" and "OPENAI_BASE_URL" in env:
            bridged = await prepare_hf_inference_bridge(
                self,
                environment,
                env,
                base_url_key="OPENAI_BASE_URL",
                api_key_key="OPENAI_API_KEY",
                inference_token=self._get_env("HF_INFERENCE_TOKEN"),
                api="chat-completions",
                allowed_model=model,
                max_requests=self._get_env("HARBOR_HF_INFERENCE_MAX_REQUESTS"),
                max_concurrency=self._get_env("HARBOR_HF_INFERENCE_MAX_CONCURRENCY"),
                timeout_seconds=self._get_env("HARBOR_HF_INFERENCE_TIMEOUT_SECONDS"),
                max_output_tokens=self._get_env(
                    "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS"
                ),
            )

        if bridged:
            hermes_provider_flag = "custom"
            cli_model = model
            config_yaml = self._build_config_yaml(
                cli_model,
                custom_base_url=env["OPENAI_BASE_URL"],
                custom_api_key=env["OPENAI_API_KEY"],
            )
        else:
            cli_model = model if hermes_provider_flag else self.model_name
            config_yaml = self._build_config_yaml(cli_model)
        env["HARBOR_INSTRUCTION"] = instruction

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; mkdir -p /tmp/hermes /logs/agent; umask 077; "
                f"printf %s {shlex.quote(config_yaml)} > /tmp/hermes/config.yaml"
            ),
            env=env,
            timeout_sec=10,
        )

        mcp_command = self._build_register_mcp_servers_command()
        if mcp_command:
            await self.exec_as_agent(
                environment, command=mcp_command, env=env, timeout_sec=10
            )
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(
                environment, command=skills_command, env=env, timeout_sec=10
            )

        cli_parts = [
            'export PATH="$HOME/.local/bin:$PATH"',
            "hermes --yolo chat",
            '-q "$HARBOR_INSTRUCTION"',
            "-Q",
            f"--model {shlex.quote(cli_model)}",
        ]
        if hermes_provider_flag:
            cli_parts.append(f"--provider {shlex.quote(hermes_provider_flag)}")
        toolsets_flag = self._resolved_flags.get("toolsets")
        if toolsets_flag:
            cli_parts.append(f"--toolsets {shlex.quote(str(toolsets_flag))}")
        run_command = (
            f"{cli_parts[0]} && {' '.join(cli_parts[1:])} "
            "2>&1 | tee /logs/agent/hermes.txt"
        )

        try:
            await self.exec_as_agent(environment, command=run_command, env=env)
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        'export PATH="$HOME/.local/bin:$PATH"; '
                        "session_id=$(sed -n 's/^session_id: //p' "
                        "/logs/agent/hermes.txt | tail -1); "
                        'if [ -n "$session_id" ]; then '
                        "hermes sessions export /logs/agent/hermes-session.jsonl "
                        '--session-id "$session_id" --yes --redact; '
                        "else hermes sessions export "
                        "/logs/agent/hermes-session.jsonl --yes --redact; fi"
                    ),
                    env={"HERMES_HOME": "/tmp/hermes"},
                    timeout_sec=60,
                )
            finally:
                if bridged:
                    await stop_hf_inference_bridge(self, environment)

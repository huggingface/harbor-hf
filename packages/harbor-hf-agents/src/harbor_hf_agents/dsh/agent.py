"""DeepSeek Harness (``dsh``) over the Harbor-HF inference bridge."""

from __future__ import annotations

import json
import shlex
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast, override

import yaml
from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
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

from harbor_hf_agents.support.hf_inference_bridge import (
    prepare_hf_inference_bridge,
    stop_hf_inference_bridge,
)
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent
from harbor_hf_agents.support.sandbox_inference_route import (
    use_sandbox_inference_route,
)

_PACKAGE = "@deepseek-ai/dsh"
_DSH_HOME = "/installed-agent/dsh-home"
_PATCH_PATH = f"{_DSH_HOME}/cordis.patch.yml"
_SETTINGS_PATH = f"{_DSH_HOME}/settings.yaml"
_API_KEY_ENV = "DSH_API_KEY"
_PLACEHOLDER_API_KEY = "not-required"
_GENERIC_PROVIDER = "harbor"
_NVM = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '


class DshAgent(IsolatedProviderAgent):
    """Headless DeepSeek Harness against an OpenAI-compatible inference route."""

    SUPPORTS_ATIF: bool = True

    def __init__(
        self,
        *args: Any,  # noqa: ANN401 -- Harbor API
        thinking_format: str | None = None,
        **kwargs: Any,  # noqa: ANN401 -- Harbor API
    ) -> None:
        super().__init__(*args, **kwargs)
        self._thinking_format = thinking_format

    @staticmethod
    @override
    def name() -> str:
        return "dsh"

    @override
    def get_version_command(self) -> str | None:
        return f"{_NVM}dsh --version"

    def _model_id(self) -> str:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        return self.model_name.split("/", 1)[1]

    def _session_root(self) -> str:
        return (self.logs_dir / "dsh-sessions").as_posix()

    def _eval_patch(self) -> str:
        return yaml.safe_dump(
            [
                {
                    "id": "agent-default-model",
                    "config": {
                        "provider": _GENERIC_PROVIDER,
                        "model": self._model_id(),
                    },
                },
                {
                    "id": "session-persistence-jsonl",
                    "config": {
                        "root": self._session_root(),
                        "compression": "none",
                        "packChunks": False,
                    },
                },
                {"id": "session-title-llm", "disabled": True},
            ],
            sort_keys=False,
        )

    def _settings(self, base_url: str) -> str:
        route: dict[str, Any] = {
            "apiKeyEnv": _API_KEY_ENV,
            "api": "openai-completions",
            "baseURL": base_url,
            "models": [{"id": self._model_id()}],
        }
        if self._thinking_format is not None:
            route["compat"] = {"thinkingFormat": self._thinking_format}
        return yaml.safe_dump(
            {"llm-pi-ai": {"providers": {_GENERIC_PROVIDER: route}}},
            sort_keys=False,
        )

    async def _upload_text(
        self,
        environment: BaseEnvironment,
        *,
        content: str,
        remote_path: str,
        filename: str,
    ) -> None:
        path = self.logs_dir / filename
        path.write_text(content, encoding="utf-8")
        if not environment.capabilities.mounted:
            await environment.upload_file(path, remote_path)
            return
        await self.exec_as_root(
            environment,
            command=(
                f"install -D -m 0644 {shlex.quote(path.as_posix())} "
                f"{shlex.quote(remote_path)}"
            ),
        )

    async def _prepare_inference_env(
        self,
        environment: BaseEnvironment,
    ) -> dict[str, str]:
        env: dict[str, str] = {
            "DSH_HOME": _DSH_HOME,
            "DSH_PERMISSION_MODE": "danger-full-access",
            "DSH_TELEMETRY_DISABLED": "1",
        }
        for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "DSH_API_KEY", "DSH_BASE_URL"):
            value = self._get_env(key)
            if value:
                env[key] = value
        allowed_model = self._model_id()
        bridged = await use_sandbox_inference_route(
            self,
            environment,
            env,
            base_url_key="DSH_BASE_URL",
            api_key_key="DSH_API_KEY",
            api="chat-completions",
            allowed_model=allowed_model,
        )
        if not bridged:
            if "DSH_BASE_URL" not in env and "OPENAI_BASE_URL" in env:
                env["DSH_BASE_URL"] = env["OPENAI_BASE_URL"]
            if "DSH_API_KEY" not in env and "OPENAI_API_KEY" in env:
                env["DSH_API_KEY"] = env["OPENAI_API_KEY"]
            bridged = await prepare_hf_inference_bridge(
                self,
                environment,
                env,
                base_url_key="DSH_BASE_URL",
                api_key_key="DSH_API_KEY",
                inference_token=self._get_env("HF_INFERENCE_TOKEN"),
                api="chat-completions",
                allowed_model=allowed_model,
                max_requests=self._get_env("HARBOR_HF_INFERENCE_MAX_REQUESTS"),
                max_concurrency=self._get_env("HARBOR_HF_INFERENCE_MAX_CONCURRENCY"),
                timeout_seconds=self._get_env("HARBOR_HF_INFERENCE_TIMEOUT_SECONDS"),
                max_output_tokens=self._get_env(
                    "HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS"
                ),
            )
        if "DSH_BASE_URL" not in env:
            raise RuntimeError("DeepSeek Harness requires DSH_BASE_URL")
        if "DSH_API_KEY" not in env:
            env["DSH_API_KEY"] = _PLACEHOLDER_API_KEY
        return env

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y --no-install-recommends "
                "ca-certificates curl passwd util-linux"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        package_spec = shlex.quote(f"{_PACKAGE}{version_spec}")
        home = shlex.quote(_DSH_HOME)
        install_script = (
            "set -euo pipefail; "
            f"{nvm_node_install_snippet()} && "
            f"npm install -g {package_spec} && "
            "dsh --version"
        )
        await self.exec_as_agent(
            environment,
            command=f"bash -lc {shlex.quote(install_script)}",
        )
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {home} && chown -R harbor-agent:harbor-agent {home}",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = await self._prepare_inference_env(environment)
        await self._upload_text(
            environment,
            content=self._eval_patch(),
            remote_path=_PATCH_PATH,
            filename="cordis.patch.yml",
        )
        await self._upload_text(
            environment,
            content=self._settings(env["DSH_BASE_URL"]),
            remote_path=_SETTINGS_PATH,
            filename="settings.yaml",
        )
        log_path = (self.logs_dir / "dsh.txt").as_posix()
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"{_NVM}"
                    f"dsh --profile headless {shlex.quote(instruction)} "
                    f"< /dev/null 2>&1 | stdbuf -oL tee {shlex.quote(log_path)}"
                ),
                env=env,
            )
        finally:
            await stop_hf_inference_bridge(self, environment)
        self._write_trajectory(context)

    def _find_session_log(self) -> Path | None:
        root = self.logs_dir / "dsh-sessions"
        if not root.is_dir():
            return None
        logs = list(root.rglob("session.jsonl"))
        if not logs:
            return None
        return max(logs, key=lambda path: path.stat().st_mtime)

    @staticmethod
    def _timestamp(event: dict[str, Any]) -> str | None:
        if "time" not in event:
            return None
        time_ms = event["time"]
        if not isinstance(time_ms, (int, float)):
            return None
        return (
            datetime.fromtimestamp(time_ms / 1000, tz=UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )

    @classmethod
    def _block_text(cls, blocks: object, *, kind: str) -> str:
        if not isinstance(blocks, list):
            return ""
        parts: list[str] = []
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != kind:
                continue
            text = block.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
        return "\n".join(parts)

    @classmethod
    def _tool_calls(cls, blocks: object) -> list[ToolCall]:
        if not isinstance(blocks, list):
            return []
        calls: list[ToolCall] = []
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "tool-call":
                continue
            raw_arguments = block.get("arguments")
            arguments: dict[str, Any] = {}
            if isinstance(raw_arguments, str) and raw_arguments:
                try:
                    parsed = json.loads(raw_arguments)
                except json.JSONDecodeError:
                    arguments = {"_raw": raw_arguments}
                else:
                    arguments = (
                        parsed if isinstance(parsed, dict) else {"_raw": raw_arguments}
                    )
            calls.append(
                ToolCall(
                    tool_call_id=str(block.get("id") or ""),
                    function_name=str(block.get("name") or ""),
                    arguments=arguments,
                )
            )
        return calls

    @staticmethod
    def _token_count(usage: object, key: str) -> int:
        if not isinstance(usage, dict):
            return 0
        payload = cast(dict[str, object], usage)
        value = payload.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return 0
        return value

    @classmethod
    def _build_metrics(cls, usage: object) -> Metrics | None:
        if not isinstance(usage, dict):
            return None
        input_tokens = cls._token_count(usage, "inputTokens")
        cache_read = cls._token_count(usage, "cacheReadTokens")
        cache_write = cls._token_count(usage, "cacheWriteTokens")
        output_tokens = cls._token_count(usage, "outputTokens")
        payload = cast(dict[str, object], usage)
        extra = {
            key: value
            for key, value in payload.items()
            if key not in {"inputTokens", "outputTokens", "cacheReadTokens"}
        }
        return Metrics(
            prompt_tokens=input_tokens + cache_read + cache_write,
            completion_tokens=output_tokens,
            cached_tokens=cache_read,
            cost_usd=None,
            extra=extra or None,
        )

    def _convert_session(self) -> Trajectory | None:  # noqa: C901 -- parser branches
        path = self._find_session_log()
        if path is None:
            return None
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return None
        events: list[dict[str, Any]] = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                events.append(record)
        steps: list[Step] = []
        calls_to_step: dict[str, Step] = {}
        step_id = 1
        total_prompt = 0
        total_completion = 0
        total_cached = 0
        for event in events:
            if event.get("type") != "assistant" and event.get("type") != "tool/result":
                continue
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            if event.get("type") == "tool/result":
                call_id = str(data.get("id") or "")
                if call_id in calls_to_step:
                    calls_to_step[call_id].observation = Observation(
                        results=[
                            ObservationResult(
                                source_call_id=call_id,
                                content=self._block_text(
                                    data.get("content"), kind="text"
                                ),
                            )
                        ]
                    )
                continue
            content = data.get("content")
            metrics = self._build_metrics(data.get("usage"))
            if metrics is not None:
                total_prompt += metrics.prompt_tokens or 0
                total_completion += metrics.completion_tokens or 0
                total_cached += metrics.cached_tokens or 0
            step = Step(
                step_id=step_id,
                timestamp=self._timestamp(event),
                source="agent",
                message=self._block_text(content, kind="text"),
                tool_calls=self._tool_calls(content),
                metrics=metrics,
            )
            for call in step.tool_calls or []:
                if call.tool_call_id:
                    calls_to_step[call.tool_call_id] = step
            steps.append(step)
            step_id += 1
        if not steps:
            return None
        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=path.parent.name,
            agent=Agent(
                name="dsh",
                version=self.version() or "unknown",
                model_name=self.model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_prompt or None,
                total_completion_tokens=total_completion or None,
                total_cached_tokens=total_cached or None,
                total_steps=len(steps),
            ),
        )

    def _write_trajectory(self, context: AgentContext) -> None:
        try:
            trajectory = self._convert_session()
        except Exception:
            self.logger.exception("Failed to convert dsh session to trajectory")
            return
        if trajectory is None:
            return
        (self.logs_dir / "trajectory.json").write_text(
            format_trajectory_json(trajectory.to_json_dict()) + "\n",
            encoding="utf-8",
        )
        if trajectory.final_metrics:
            context.n_input_tokens = trajectory.final_metrics.total_prompt_tokens or 0
            context.n_output_tokens = (
                trajectory.final_metrics.total_completion_tokens or 0
            )

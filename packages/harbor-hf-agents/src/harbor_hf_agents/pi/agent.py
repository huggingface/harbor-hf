import inspect
import json
import re
import shlex
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast, override
from urllib.parse import urlsplit

from harbor.agents.installed.base import CliFlag, with_prompt_template
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
from packaging.version import InvalidVersion, Version

from harbor_hf_agents.support.hf_inference_bridge import (
    prepare_hf_inference_bridge,
    stop_hf_inference_bridge,
    verify_hf_inference_isolation,
)
from harbor_hf_agents.support.isolated_user import IsolatedProviderAgent

_CURRENT_PI_PACKAGE = "@earendil-works/pi-coding-agent"
_LEGACY_PI_PACKAGE = "@mariozechner/pi-coding-agent"
_PI_PACKAGE_RENAME_VERSION = Version("0.74.0")


def _materialize_pi_models_json() -> None:
    """Create Pi's runtime models file without retaining scoped route values."""
    import json
    import os
    from pathlib import Path

    source = Path("/logs/agent/pi.models.template.json")
    destination = Path.home() / ".pi" / "agent" / "models.json"
    value = json.loads(source.read_text(encoding="utf-8"))
    for provider in value["providers"].values():
        base_url = provider["baseUrl"]
        if base_url.startswith("${") and base_url.endswith("}"):
            env_name = base_url[2:-1]
        elif base_url.startswith("$"):
            env_name = base_url[1:]
        else:
            continue
        resolved = os.environ.get(env_name)
        if not resolved:
            raise RuntimeError(f"required Pi model environment {env_name} is missing")
        provider["baseUrl"] = resolved
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    destination.chmod(0o600)


async def _use_sandbox_inference_route(
    agent: IsolatedProviderAgent,
    environment: BaseEnvironment,
    env: dict[str, str],
    *,
    allowed_model: str,
) -> bool:
    """Load a non-secret loopback route prepared by the Sandbox root process."""
    result = await agent.exec_as_root(
        environment,
        command=(
            "if [ -f /run/harbor-hf-inference.json ]; then "
            "cat /run/harbor-hf-inference.json; fi"
        ),
    )
    text = (result.stdout or "").strip()
    if not text:
        return False
    value = json.loads(text)
    if set(value) != {"schema_version", "api", "base_url", "api_key", "model"}:
        raise RuntimeError("Sandbox inference route has unknown or missing fields")
    if (
        value["schema_version"] != "v1"
        or value["api"] != "chat-completions"
        or value["base_url"] != "http://127.0.0.1:18080/v1"
        or value["api_key"] != "harbor-local-inference-bridge"
        or value["model"] != allowed_model
    ):
        raise RuntimeError("Sandbox inference route does not match the locked model")
    env["OPENAI_BASE_URL"] = value["base_url"]
    env["OPENAI_API_KEY"] = value["api_key"]
    await verify_hf_inference_isolation(agent, environment)
    return True


def pi_jsonl_to_atif_trajectory(  # noqa: C901 -- parser branches
    path: Path | str,
    *,
    version: str,
    model_name: str | None,
) -> Trajectory | None:
    """Convert Pi's stable JSON event stream to an ATIF trajectory."""
    path = Path(path)
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    session_id = "unknown"
    messages: list[dict[str, Any]] = []
    for line in lines:
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if event.get("type") == "session" and isinstance(event.get("id"), str):
            session_id = event["id"]
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if isinstance(message, dict):
            messages.append(message)

    def text_content(content: object) -> str:
        if not isinstance(content, list):
            return ""
        texts: list[str] = []
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "text":
                continue
            part_text = part.get("text")
            if isinstance(part_text, str):
                texts.append(part_text)
        return "".join(texts)

    def assistant_content(content: object) -> tuple[str, list[ToolCall]]:
        if not isinstance(content, list):
            return "", []
        text: list[str] = []
        calls: list[ToolCall] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_text = part.get("text")
            name = part.get("name")
            if part.get("type") == "text" and isinstance(part_text, str):
                text.append(part_text)
            elif part.get("type") == "toolCall" and isinstance(name, str):
                arguments = part.get("arguments")
                calls.append(
                    ToolCall(
                        tool_call_id=str(part.get("id") or ""),
                        function_name=name,
                        arguments=(
                            cast(dict[str, Any], arguments)
                            if isinstance(arguments, dict)
                            else {}
                        ),
                    )
                )
        return "".join(text), calls

    def token_count(usage: Mapping[str, Any], key: str) -> int:
        value = usage.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    def metrics(usage: object) -> Metrics | None:
        if not isinstance(usage, dict):
            return None
        typed_usage = cast(dict[str, Any], usage)
        input_tokens = token_count(typed_usage, "input")
        output_tokens = token_count(typed_usage, "output")
        cache_read = token_count(typed_usage, "cacheRead")
        cache_write = token_count(typed_usage, "cacheWrite")
        if not (input_tokens or output_tokens or cache_read or cache_write):
            return None
        return Metrics(
            prompt_tokens=input_tokens + cache_read or None,
            completion_tokens=output_tokens or None,
            cached_tokens=cache_read or None,
            extra=({"cache_write_tokens": cache_write} if cache_write else None),
        )

    steps: list[Step] = []
    total_input = 0
    total_output = 0
    total_cache = 0
    index = 0
    while index < len(messages):
        message = messages[index]
        role = message.get("role")
        if role == "user":
            steps.append(
                Step(
                    step_id=len(steps) + 1,
                    source="user",
                    message=text_content(message.get("content"))
                    or "(empty user message)",
                )
            )
            index += 1
            continue
        if role != "assistant":
            index += 1
            continue
        text, calls = assistant_content(message.get("content"))
        usage = message.get("usage")
        step_metrics = metrics(usage)
        if isinstance(usage, dict):
            typed_usage = cast(dict[str, Any], usage)
            total_input += token_count(typed_usage, "input")
            total_output += token_count(typed_usage, "output")
            total_cache += token_count(typed_usage, "cacheRead")
        pending = {call.tool_call_id for call in calls if call.tool_call_id}
        results: list[ObservationResult] = []
        cursor = index + 1
        while cursor < len(messages) and messages[cursor].get("role") == "toolResult":
            result = messages[cursor]
            call_id = str(result.get("toolCallId") or "")
            if pending and call_id not in pending:
                break
            results.append(
                ObservationResult(
                    source_call_id=call_id or None,
                    content=text_content(result.get("content")) or None,
                )
            )
            pending.discard(call_id)
            cursor += 1
        steps.append(
            Step(
                step_id=len(steps) + 1,
                source="agent",
                message=text.strip() or "(no assistant text)",
                model_name=model_name,
                tool_calls=calls or None,
                observation=Observation(results=results) if results else None,
                metrics=step_metrics,
            )
        )
        index = cursor
    if len(steps) < 2:
        return None
    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=session_id,
        agent=Agent(name="pi", version=version, model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_input + total_cache or None,
            total_completion_tokens=total_output or None,
            total_cached_tokens=total_cache or None,
            total_steps=len(steps),
        ),
    )


class PiAgent(IsolatedProviderAgent):
    SUPPORTS_ATIF: bool = True
    _OUTPUT_FILENAME = "pi.txt"
    _MODELS_TEMPLATE_FILENAME = "pi.models.template.json"

    def __init__(
        self,
        *args: Any,  # noqa: ANN401 -- Harbor API
        models_json: dict[str, Any] | None = None,
        provider_runtime: dict[str, Any] | None = None,
        **kwargs: Any,  # noqa: ANN401 -- Harbor API
    ) -> None:
        super().__init__(*args, **kwargs)
        self._models_json = models_json
        if models_json is not None:
            self._validate_models_json(models_json)
        self._validate_provider_runtime(provider_runtime)

    @staticmethod
    def _validate_provider_runtime(value: dict[str, Any] | None) -> None:
        if value is None:
            return
        if value.get("api") != "chat-completions":
            raise ValueError("Pi requires the chat-completions API")
        if set(value) != {"api", "timeout_seconds", "max_attempts"}:
            raise ValueError("provider_runtime has unknown or missing fields")

    @classmethod
    def _validate_models_json(cls, value: dict[str, Any]) -> None:
        if set(value) != {"providers"} or not isinstance(value["providers"], dict):
            raise ValueError("Pi models_json must contain exactly one providers object")
        json.dumps(value, allow_nan=False)
        for provider in value["providers"].values():
            if not isinstance(provider, dict):
                raise ValueError("Pi models_json providers must be objects")
            base_url = provider.get("baseUrl")
            if not isinstance(base_url, str) or not cls._safe_model_base_url(base_url):
                raise ValueError(
                    "Pi provider baseUrl must be an environment reference or a safe URL"
                )
            api_key = provider.get("apiKey")
            if api_key is not None and not cls._environment_reference(api_key):
                raise ValueError("Pi provider apiKey must be an environment reference")
            headers = provider.get("headers", {})
            if not isinstance(headers, dict) or any(
                not cls._environment_reference(item) for item in headers.values()
            ):
                raise ValueError(
                    "Pi provider header values must be environment references"
                )
            if cls._contains_shell_resolution(provider):
                raise ValueError("Pi models_json must not execute shell commands")

    @staticmethod
    def _environment_reference(value: object) -> bool:
        return (
            isinstance(value, str)
            and re.fullmatch(
                r"\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})",
                value,
            )
            is not None
        )

    @classmethod
    def _safe_model_base_url(cls, value: str) -> bool:
        if cls._environment_reference(value):
            return True
        parsed = urlsplit(value)
        return (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and "/scopes/" not in parsed.path
        )

    @classmethod
    def _contains_shell_resolution(cls, value: object) -> bool:
        if isinstance(value, str):
            return value.startswith("!")
        if isinstance(value, dict):
            return any(cls._contains_shell_resolution(item) for item in value.values())
        if isinstance(value, list):
            return any(cls._contains_shell_resolution(item) for item in value)
        return False

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
    ]

    @staticmethod
    @override
    def name() -> str:
        return "pi"

    @override
    def get_version_command(self) -> str | None:
        return "bash -lc " + shlex.quote(". ~/.nvm/nvm.sh; pi --version")

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

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
        package = _CURRENT_PI_PACKAGE
        if self._version:
            try:
                if Version(self._version) < _PI_PACKAGE_RENAME_VERSION:
                    package = _LEGACY_PI_PACKAGE
            except InvalidVersion:
                pass
        version_spec = f"@{self._version}" if self._version else "@latest"
        install_script = (
            "set -euo pipefail; "
            f"{nvm_node_install_snippet()} && "
            f"npm install -g {package}{version_spec} && "
            "pi --version"
        )
        # nvm is a bash function; the default exec shell is /bin/sh, where
        # sourcing nvm.sh yields "nvm: not found" (exit 127). Run under bash.
        await self.exec_as_agent(
            environment,
            command=f"bash -lc {shlex.quote(install_script)}",
        )

    def _build_register_skills_command(self) -> str | None:
        """Return a shell command that copies skills to Pi's skills directory."""
        if not self.skills_dir:
            return None
        return (
            f"mkdir -p $HOME/.agents/skills && "
            f"cp -r {shlex.quote(self.skills_dir)}/* "
            f"$HOME/.agents/skills/ 2>/dev/null || true"
        )

    @staticmethod
    def _materialize_models_command() -> str:
        body = inspect.getsource(_materialize_pi_models_json)
        script = body + "\n_materialize_pi_models_json()\n"
        return "python3 -c " + shlex.quote(script)

    @override
    @with_prompt_template
    async def run(  # noqa: C901 -- parser branches
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, _ = self.model_name.split("/", 1)

        env: dict[str, str] = {}
        keys: list[str] = []

        if provider == "amazon-bedrock":
            keys.extend(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"])
        elif provider == "anthropic":
            keys.extend(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
        elif provider == "github-copilot":
            keys.append("GITHUB_TOKEN")
        elif provider == "google":
            keys.extend(
                [
                    "GEMINI_API_KEY",
                    "GOOGLE_GENERATIVE_AI_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    "GOOGLE_CLOUD_PROJECT",
                    "GOOGLE_CLOUD_LOCATION",
                    "GOOGLE_GENAI_USE_VERTEXAI",
                    "GOOGLE_API_KEY",
                ]
            )
        elif provider == "groq":
            keys.append("GROQ_API_KEY")
        elif provider == "huggingface":
            keys.append("HF_TOKEN")
        elif provider == "mistral":
            keys.append("MISTRAL_API_KEY")
        elif provider == "openai":
            keys.extend(["OPENAI_API_KEY", "OPENAI_BASE_URL"])
        elif provider == "openrouter":
            keys.append("OPENROUTER_API_KEY")
        elif provider == "xai":
            keys.append("XAI_API_KEY")

        for key in keys:
            val = self._get_env(key)
            if val:
                env[key] = val

        allowed_model = self.model_name.split("/", 1)[1]
        bridged = False
        if provider == "openai":
            bridged = await _use_sandbox_inference_route(
                self,
                environment,
                env,
                allowed_model=allowed_model,
            )
        if not bridged:
            bridged = await prepare_hf_inference_bridge(
                self,
                environment,
                env,
                base_url_key="OPENAI_BASE_URL",
                api_key_key="OPENAI_API_KEY",
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

        model_args = (
            f"--provider {provider} --model {self.model_name.split('/', 1)[1]} "
        )

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)

        if self._models_json is not None:
            template = self.logs_dir / self._MODELS_TEMPLATE_FILENAME
            template.write_text(
                json.dumps(self._models_json, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            if not environment.capabilities.mounted:
                await environment.upload_file(
                    template,
                    f"/logs/agent/{self._MODELS_TEMPLATE_FILENAME}",
                )
            await self.exec_as_agent(
                environment,
                command=self._materialize_models_command(),
                env=env,
            )

        try:
            await self.exec_as_agent(
                environment,
                command="bash -lc "
                + shlex.quote(
                    ". ~/.nvm/nvm.sh; "
                    "pi --print --mode json --session-dir /logs/agent/pi/sessions "
                    f"{model_args}"
                    f"{cli_flags}"
                    f"{escaped_instruction} "
                    "2>&1 </dev/null | "
                    'grep -v \'"type":"message_update"\' | '
                    f"stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}"
                ),
                env=env,
            )
        finally:
            try:
                if self._models_json is not None:
                    await self.exec_as_agent(
                        environment,
                        command="rm -f $HOME/.pi/agent/models.json",
                        env=env,
                    )
            finally:
                if bridged:
                    await stop_hf_inference_bridge(self, environment)

    @override
    def populate_context_post_run(  # noqa: C901 -- parser branches
        self, context: AgentContext
    ) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0

        for line in output_file.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                if event.get("type") == "message_end":
                    message = event.get("message") or {}
                    if message.get("role") == "assistant":
                        usage = message.get("usage") or {}
                        total_input_tokens += usage.get("input", 0)
                        total_output_tokens += usage.get("output", 0)
                        total_cache_read_tokens += usage.get("cacheRead", 0)
                        total_cache_write_tokens += usage.get("cacheWrite", 0)
                        cost = usage.get("cost") or {}
                        total_cost += cost.get("total", 0.0)
            except (json.JSONDecodeError, AttributeError, TypeError):
                continue

        context.n_input_tokens = total_input_tokens + total_cache_read_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_read_tokens
        context.cost_usd = total_cost if total_cost > 0 else None

        try:
            trajectory = pi_jsonl_to_atif_trajectory(
                output_file,
                version=self.version() or "unknown",
                model_name=self.model_name,
            )
            if trajectory is not None:
                (self.logs_dir / "trajectory.json").write_text(
                    format_trajectory_json(trajectory.to_json_dict()),
                    encoding="utf-8",
                )
        except Exception:
            self.logger.exception("Failed to convert Pi JSON to trajectory")

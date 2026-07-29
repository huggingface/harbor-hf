"""OpenClaw installed agent that executes turns with the Codex app-server harness."""

import inspect
import re
import shlex
from typing import Any, override

from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_hf_agents.openclaw.agent import OpenClawAgent
from harbor_hf_agents.support.hf_jobs_ingress import (
    prepare_hf_jobs_ingress_bridge,
    stop_hf_jobs_ingress_bridge,
)

_DEFAULT_CODEX_PLUGIN_VERSION = "2026.7.1-1"


def _materialize_openclaw_codex_config() -> None:
    """Write the isolated Codex provider config from runtime-only environment."""
    import json
    import os
    import re
    from pathlib import Path

    base_url = os.environ.get("OPENAI_BASE_URL")
    if not base_url:
        raise RuntimeError("OPENAI_BASE_URL is required for the Codex runtime")
    agent_id = os.environ.get("OPENCLAW_AGENT_ID", "main")
    if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", agent_id) is None:
        raise RuntimeError("OPENCLAW_AGENT_ID is invalid")
    destination = (
        Path.home()
        / ".openclaw"
        / "agents"
        / agent_id
        / "agent"
        / "codex-home"
        / "config.toml"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        f"openai_base_url = {json.dumps(base_url)}\n",
        encoding="utf-8",
    )
    destination.chmod(0o600)


def _collect_openclaw_codex_evidence(  # noqa: C901 -- parser branches
    log_root: str = "/logs/agent", home: str | None = None
) -> None:
    """Validate Codex identity and retain non-credential runtime evidence."""
    import json
    import os
    from pathlib import Path
    from urllib.parse import urlsplit

    max_files = 10_000
    max_bytes = 512 * 1024 * 1024
    redaction_count = 0
    sensitive_values = {
        value.encode()
        for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL")
        if (value := os.environ.get(name))
    }
    base_url = os.environ.get("OPENAI_BASE_URL", "")
    if base_url:
        parts = [part for part in urlsplit(base_url).path.split("/") if part]
        if "scopes" in parts and parts.index("scopes") + 1 < len(parts):
            sensitive_values.add(parts[parts.index("scopes") + 1].encode())
    ordered_sensitive_values = tuple(
        sorted(sensitive_values, key=lambda item: (-len(item), item))
    )

    def redact_prefix(content: bytes, *, final: bool) -> tuple[bytes, bytes]:
        nonlocal redaction_count
        if not ordered_sensitive_values:
            return content, b""
        max_secret_size = max(len(secret) for secret in ordered_sensitive_values)
        cutoff = len(content) if final else max(0, len(content) - max_secret_size + 1)
        output = bytearray()
        cursor = 0
        while cursor < cutoff:
            matched = next(
                (
                    secret
                    for secret in ordered_sensitive_values
                    if content.startswith(secret, cursor)
                ),
                None,
            )
            if matched is not None:
                output.extend(b"[REDACTED]")
                redaction_count += 1
                cursor += len(matched)
                continue
            output.append(content[cursor])
            cursor += 1
        return bytes(output), content[cursor:]

    def copy_sanitized(source: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        carry = b""
        with source.open("rb") as input_stream, destination.open("wb") as output_stream:
            while chunk := input_stream.read(1024 * 1024):
                redacted, carry = redact_prefix(carry + chunk, final=False)
                output_stream.write(redacted)
            redacted, carry = redact_prefix(carry, final=True)
            output_stream.write(redacted)
            if carry:
                raise RuntimeError("Codex evidence redaction did not consume the input")

    def contains_marker(path: Path, marker: bytes) -> bool:
        overlap = b""
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                candidate = overlap + chunk
                if marker in candidate:
                    return True
                overlap_size = max(0, len(marker) - 1)
                overlap = candidate[-overlap_size:] if overlap_size else b""
        return False

    logs = Path(log_root)
    user_home = Path(home or os.path.expanduser("~"))
    output = logs / "openclaw.txt"
    raw = output.read_text(encoding="utf-8", errors="replace").strip()
    decoder = json.JSONDecoder()
    envelope = None
    for start in range(len(raw) - 1, -1, -1):
        if raw[start] != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(raw[start:])
        except (json.JSONDecodeError, ValueError):
            continue
        if (
            isinstance(candidate, dict)
            and "payloads" in candidate
            and "meta" in candidate
        ):
            envelope = candidate
            break
    if envelope is None:
        raise RuntimeError("OpenClaw output has no JSON envelope")

    meta = envelope.get("meta")
    agent_meta = meta.get("agentMeta") if isinstance(meta, dict) else None
    if not isinstance(agent_meta, dict):
        raise RuntimeError("OpenClaw output has no agent metadata")
    session_id = agent_meta.get("sessionId")
    session_file_value = agent_meta.get("sessionFile")
    if not isinstance(session_id, str) or not session_id:
        raise RuntimeError("OpenClaw output has no session ID")
    if not isinstance(session_file_value, str) or not session_file_value:
        raise RuntimeError("OpenClaw output has no session file")

    session_file = Path(session_file_value)
    try:
        session_file.resolve().relative_to(user_home.resolve())
    except ValueError as error:
        raise RuntimeError("OpenClaw session file is outside the agent home") from error
    if not session_file.is_file():
        raise RuntimeError("OpenClaw session file is missing")
    sessions_store = session_file.parent / "sessions.json"
    store = json.loads(sessions_store.read_text(encoding="utf-8"))
    if not isinstance(store, dict):
        raise RuntimeError("OpenClaw session store is malformed")
    entry = next(
        (
            candidate
            for candidate in store.values()
            if isinstance(candidate, dict) and candidate.get("sessionId") == session_id
        ),
        None,
    )
    if entry is None:
        raise RuntimeError("OpenClaw session store has no matching entry")
    if entry.get("agentHarnessId") != "codex":
        raise RuntimeError("OpenClaw session did not use the Codex harness")

    binding_file = Path(f"{session_file}.codex-app-server.json")
    binding = json.loads(binding_file.read_text(encoding="utf-8"))
    if not isinstance(binding, dict) or not isinstance(binding.get("threadId"), str):
        raise RuntimeError("Codex app-server binding is missing or malformed")

    retained = logs / "codex-runtime"
    retained.mkdir(parents=True, exist_ok=True)
    copy_sanitized(session_file, retained / "openclaw.session.jsonl")
    copy_sanitized(sessions_store, retained / "openclaw.sessions.json")
    copy_sanitized(binding_file, retained / "codex-app-server-binding.json")

    agent_dir = session_file.parent.parent
    codex_home_candidates = (
        agent_dir / "codex-home",
        agent_dir / "agent" / "codex-home",
        agent_dir.parent / "codex-home",
    )
    codex_home = next((path for path in codex_home_candidates if path.is_dir()), None)
    if codex_home is None:
        raise RuntimeError("isolated Codex home is missing")

    transcript_roots = (
        codex_home / "sessions",
        codex_home / "home" / ".codex" / "sessions",
    )
    copied_files = 0
    copied_bytes = 0
    transcript_files = 0
    matching_transcripts = 0
    thread_marker = binding["threadId"].encode()
    for source_root in transcript_roots:
        if not source_root.is_dir():
            continue
        destination_root = (
            retained / "native-sessions" / source_root.relative_to(codex_home)
        )
        for source in sorted(source_root.rglob("*")):
            if source.is_symlink() or not source.is_file():
                continue
            copied_files += 1
            copied_bytes += source.stat().st_size
            if copied_files > max_files or copied_bytes > max_bytes:
                raise RuntimeError("Codex runtime evidence exceeds retention bounds")
            destination = destination_root / source.relative_to(source_root)
            copy_sanitized(source, destination)
            if source.suffix == ".jsonl":
                transcript_files += 1
                if contains_marker(source, thread_marker):
                    matching_transcripts += 1
    if transcript_files == 0:
        raise RuntimeError("Codex native session transcript is missing")
    if matching_transcripts == 0:
        raise RuntimeError("Codex native transcript does not match the bound thread")

    execution_trace = meta.get("executionTrace") if isinstance(meta, dict) else None
    runtime_evidence = {
        "schema_version": "harbor/openclaw-codex-runtime/v1alpha1",
        "agentHarnessId": "codex",
        "sessionId": session_id,
        "threadId": binding["threadId"],
        "model": binding.get("model"),
        "modelProvider": binding.get("modelProvider"),
        "executionTrace": execution_trace,
        "nativeTranscriptFiles": transcript_files,
        "matchingNativeTranscriptFiles": matching_transcripts,
        "retainedFiles": copied_files + 3,
        "retainedBytes": copied_bytes,
        "redactionCount": redaction_count,
    }
    (retained / "runtime-evidence.json").write_text(
        json.dumps(runtime_evidence, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


class OpenClawCodexAgent(OpenClawAgent):
    """Run OpenClaw through its first-party Codex app-server harness plugin."""

    _SUPPORTED_PROVIDERS = frozenset({"openai"})
    _PROVIDER_API = "responses"

    def __init__(
        self,
        *args: Any,  # noqa: ANN401 -- Harbor API
        codex_plugin_version: str = _DEFAULT_CODEX_PLUGIN_VERSION,
        codex_request_timeout_ms: int = 600_000,
        model_context_window: int = 262_144,
        model_max_tokens: int = 32_768,
        **kwargs: Any,  # noqa: ANN401 -- Harbor API
    ) -> None:
        super().__init__(*args, **kwargs)
        if (
            re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", codex_plugin_version)
            is None
        ):
            raise ValueError("codex_plugin_version must be an exact npm version")
        if codex_request_timeout_ms < 1:
            raise ValueError("codex_request_timeout_ms must be positive")
        if model_context_window < 1 or model_max_tokens < 1:
            raise ValueError("Codex model token limits must be positive")
        if model_max_tokens > model_context_window:
            raise ValueError("Codex model output limit exceeds its context window")
        self._codex_plugin_version = codex_plugin_version
        self._codex_request_timeout_ms = codex_request_timeout_ms
        self._model_context_window = model_context_window
        self._model_max_tokens = model_max_tokens

    @staticmethod
    @override
    def name() -> str:
        return "openclaw-codex"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        package = shlex.quote(f"npm:@openclaw/codex@{self._codex_plugin_version}")
        await self.exec_as_agent(
            environment,
            command=self._node_command(f"openclaw plugins install {package}"),
            timeout_sec=self._install_exec_timeout_sec,
        )

    @override
    def _merge_provider_base_url_from_env(self, cfg: dict[str, Any]) -> None:
        # The scoped URL is runtime-only authorization. Codex consumes it from the
        # environment; writing it into OpenClaw's retained upload config would leak it.
        del cfg

    @override
    def _build_full_openclaw_config(self) -> dict[str, Any]:
        config = super()._build_full_openclaw_config()
        plugins = config.setdefault("plugins", {})
        plugins["enabled"] = True
        allow = plugins.setdefault("allow", [])
        if not isinstance(allow, list):
            raise ValueError("plugins.allow must be a list")
        if "codex" not in allow:
            allow.append("codex")
        entries = plugins.setdefault("entries", {})
        entries["codex"] = {
            "enabled": True,
            "config": {
                "discovery": {"enabled": False},
                "appServer": {
                    "mode": "yolo",
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "requestTimeoutMs": self._codex_request_timeout_ms,
                },
            },
        }

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Codex runtime requires a provider/model name")
        provider, model_id = self.model_name.split("/", 1)
        if provider != "openai":
            raise ValueError("OpenClaw Codex runtime requires the openai provider")
        models_root = config.setdefault("models", {})
        providers = models_root.setdefault("providers", {})
        provider_config = providers.setdefault(provider, {})
        provider_config.update(
            {
                "api": "openai-responses",
                "baseUrl": "https://router.huggingface.co/v1",
                "apiKey": "harbor-hf-scoped-provider-proxy",
            }
        )
        catalog = provider_config.setdefault("models", [])
        if not isinstance(catalog, list):
            raise ValueError("OpenClaw provider models must be a list")
        catalog[:] = [
            candidate
            for candidate in catalog
            if not isinstance(candidate, dict) or candidate.get("id") != model_id
        ]
        catalog.append(
            {
                "id": model_id,
                "name": model_id,
                "reasoning": True,
                "input": ["text"],
                "contextWindow": self._model_context_window,
                "maxTokens": self._model_max_tokens,
            }
        )

        agents = config.setdefault("agents", {})
        defaults = agents.setdefault("defaults", {})
        models = defaults.setdefault("models", {})
        models[self.model_name] = {"agentRuntime": {"id": "codex"}}
        return config

    @staticmethod
    def _materialize_codex_config_command() -> str:
        body = inspect.getsource(_materialize_openclaw_codex_config)
        script = body + "\n_materialize_openclaw_codex_config()\n"
        return "python3 -c " + shlex.quote(script)

    @staticmethod
    def _collect_runtime_evidence_command() -> str:
        body = inspect.getsource(_collect_openclaw_codex_evidence)
        script = body + "\n_collect_openclaw_codex_evidence()\n"
        return "python3 -c " + shlex.quote(script)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = {
            key: value
            for key in self._provider_env_keys(self._model_provider() or "")
            if (value := self._get_env(key))
        }
        env["OPENCLAW_AGENT_ID"] = self._resolved_openclaw_agent_id()
        bridged = await prepare_hf_jobs_ingress_bridge(
            self,
            environment,
            env,
            base_url_key="OPENAI_BASE_URL",
            api_key_key="OPENAI_API_KEY",
            ingress_token=self._get_env("HF_TOKEN"),
            api="responses",
        )
        try:
            await self.exec_as_agent(
                environment,
                command=self._materialize_codex_config_command(),
                env=env,
            )
            await self._run_prepared(instruction, environment, context, env)
            await self.exec_as_agent(
                environment,
                command=self._node_command(
                    "openclaw plugins inspect codex --json "
                    "> /logs/agent/openclaw-codex-plugin.json"
                ),
                env=env,
            )
            await self.exec_as_agent(
                environment,
                command=self._collect_runtime_evidence_command(),
                env=env,
            )
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        "agent_id=$OPENCLAW_AGENT_ID; "
                        'rm -f "$HOME/.openclaw/agents/$agent_id/agent/'
                        'codex-home/config.toml"'
                    ),
                    env=env,
                )
            finally:
                if bridged:
                    await stop_hf_jobs_ingress_bridge(self, environment)

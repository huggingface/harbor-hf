"""Pi with the temporary Harbor-HF ATIF converter."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any, cast, override
from urllib.parse import quote
from urllib.request import Request, urlopen

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.pi import Pi
from harbor.agents.model_connection import ResolvedModelConnection
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json

_HF_ROUTER_URL = "https://router.huggingface.co/v1"
_PI_HF_CATALOG_URL = "https://pi.dev/api/models/providers/huggingface"
_PI_CUSTOM_PROVIDER = "harbor-endpoint"

JsonFetcher = Callable[[str], object]


@lru_cache(maxsize=256)
def _fetch_json(url: str) -> object:
    request = Request(
        url,
        headers={"accept": "application/json", "User-Agent": "harbor-hf/0.1"},
    )
    try:
        with urlopen(request, timeout=8) as response:  # noqa: S310 -- fixed HTTPS URLs
            return json.load(response)
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("required model metadata is unavailable") from error


def _models(value: object) -> list[dict[str, Any]]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, dict):
        listed = value.get("models")
        items = listed if isinstance(listed, list) else list(value.values())
    else:
        raise RuntimeError("Pi returned invalid Hugging Face model metadata")
    return [cast(dict[str, Any], item) for item in items if isinstance(item, dict)]


def _price(value: object, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        message = f"the selected provider did not report a valid {label} price"
        raise RuntimeError(message)
    return float(value)


def _positive_int(value: object, message: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimeError(message)
    return value


def _base_model(model_id: str, fetch_json: JsonFetcher) -> dict[str, Any]:
    model = next(
        (
            item
            for item in _models(fetch_json(_PI_HF_CATALOG_URL))
            if item.get("id") == model_id
        ),
        None,
    )
    if model is None:
        raise RuntimeError("Pi did not report the selected Hugging Face model")
    if model.get("api") != "openai-completions":
        raise RuntimeError("the selected Pi model does not use chat completions")
    return model


def _provider_metadata(
    model_id: str,
    provider_id: str,
    fetch_json: JsonFetcher,
) -> dict[str, Any]:
    router_url = f"{_HF_ROUTER_URL}/models/{quote(model_id, safe='/')}"
    value = fetch_json(router_url)
    if not isinstance(value, dict):
        raise RuntimeError("Hugging Face returned invalid provider metadata")
    data = value.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("Hugging Face returned invalid provider metadata")
    providers = data.get("providers")
    if not isinstance(providers, list):
        raise RuntimeError("Hugging Face did not report model providers")
    provider = next(
        (
            cast(dict[str, Any], item)
            for item in providers
            if isinstance(item, dict) and item.get("provider") == provider_id
        ),
        None,
    )
    if provider is None or provider.get("status") != "live":
        raise RuntimeError("the selected inference provider is not live for this model")
    if provider.get("supports_tools") is not True:
        raise RuntimeError("the selected inference provider does not support tools")
    return provider


def build_provider_pinned_model(
    model_id: str,
    *,
    fetch_json: JsonFetcher = _fetch_json,
) -> dict[str, Any]:
    """Combine Pi model behavior with current provider price and context metadata."""
    base_model_id, separator, provider_id = model_id.rpartition(":")
    if not separator or not base_model_id or not provider_id:
        raise ValueError("a provider-pinned model id is required")

    base = _base_model(base_model_id, fetch_json)
    provider = _provider_metadata(base_model_id, provider_id, fetch_json)
    pricing = provider.get("pricing")
    if not isinstance(pricing, dict):
        raise RuntimeError("the selected inference provider did not report pricing")
    context_window = _positive_int(
        provider.get("context_length"),
        "the selected inference provider did not report a context limit",
    )
    max_tokens = _positive_int(
        base.get("maxTokens"), "Pi did not report a valid output limit"
    )

    model = {
        key: base[key]
        for key in (
            "reasoning",
            "thinkingLevelMap",
            "input",
            "samplingParams",
            "compat",
        )
        if key in base
    }
    model.update(
        {
            "id": model_id,
            "name": f"{base.get('name', base_model_id)} · {provider_id}",
            "api": "openai-completions",
            "cost": {
                "input": _price(pricing.get("input"), "input"),
                "output": _price(pricing.get("output"), "output"),
                "cacheRead": 0,
                "cacheWrite": 0,
            },
            "contextWindow": context_window,
            "maxTokens": min(max_tokens, context_window),
        }
    )
    return model


def _text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        value = item.get("text")
        if isinstance(value, str) and item.get("type") in {"text", "thinking"}:
            parts.append(value)
    return "\n".join(parts)


def _tool_calls(content: object) -> list[ToolCall]:
    if not isinstance(content, list):
        return []
    calls: list[ToolCall] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "toolCall":
            continue
        name = item.get("name")
        if not isinstance(name, str):
            continue
        raw = item.get("arguments")
        arguments = cast(dict[str, Any], raw) if isinstance(raw, dict) else {"raw": raw}
        calls.append(
            ToolCall(
                tool_call_id=str(item.get("id") or ""),
                function_name=name,
                arguments=arguments,
            )
        )
    return calls


def pi_jsonl_to_atif_trajectory(  # noqa: C901 -- event parser branches
    path: Path | str,
    *,
    version: str,
    model_name: str | None,
) -> Trajectory | None:
    """Convert Pi's stable JSON event stream to an ATIF trajectory."""
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    session_id = "unknown"
    messages: list[dict[str, Any]] = []
    for line in lines:
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "session" and isinstance(event.get("id"), str):
            session_id = event["id"]
        if event.get("type") == "message_end" and isinstance(
            event.get("message"), dict
        ):
            messages.append(event["message"])

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
                    message=_text(message.get("content")) or "(empty user message)",
                )
            )
            index += 1
            continue
        if role != "assistant":
            index += 1
            continue
        usage = message.get("usage")
        if isinstance(usage, dict):
            for field, target in (
                ("input", "input"),
                ("output", "output"),
                ("cacheRead", "cache"),
            ):
                value = usage.get(field)
                if isinstance(value, int) and value >= 0:
                    if target == "input":
                        total_input += value
                    elif target == "output":
                        total_output += value
                    else:
                        total_cache += value
        calls = _tool_calls(message.get("content"))
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
                    content=_text(result.get("content")) or None,
                )
            )
            pending.discard(call_id)
            cursor += 1
        steps.append(
            Step(
                step_id=len(steps) + 1,
                source="agent",
                message=_text(message.get("content")) or "(no assistant text)",
                model_name=model_name,
                tool_calls=calls or None,
                observation=Observation(results=results) if results else None,
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


class PiAgent(Pi):
    """Use Harbor's Pi agent with priced provider pins and ATIF output."""

    capabilities = AgentCapabilities(atif=True, resume=True)
    _provider_model: dict[str, Any] | None = None

    @override
    def _build_custom_models_json(
        self,
        access: ResolvedModelConnection,
        model_id: str,
    ) -> dict[str, Any] | None:
        if self._provider_model is None:
            return super()._build_custom_models_json(access, model_id)
        api_key_env = self._api_key_env_name(access)
        if api_key_env is None:
            raise ValueError("Pi requires a Hugging Face token environment reference")
        return {
            "providers": {
                _PI_CUSTOM_PROVIDER: {
                    "baseUrl": _HF_ROUTER_URL,
                    "apiKey": f"${api_key_env}",
                    "api": "openai-completions",
                    "models": [self._provider_model],
                }
            }
        }

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if self.model_name and self.model_name.startswith("huggingface/"):
            model_id = self.model_name.split("/", 1)[1]
            if ":" in model_id:
                self._provider_model = await asyncio.to_thread(
                    build_provider_pinned_model, model_id
                )
        try:
            await super().run(instruction, environment, context)
        finally:
            self._provider_model = None

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        output_file = self.logs_dir / self._OUTPUT_FILENAME
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
            self.logger.exception("Failed to convert Pi output to ATIF")

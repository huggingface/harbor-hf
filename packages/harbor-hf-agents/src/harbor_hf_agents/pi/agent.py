"""Pi with the temporary Harbor-HF ATIF converter."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.pi import Pi
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
    """Use Harbor's Pi agent and add the converter that is not upstream yet."""

    capabilities = AgentCapabilities(atif=True, resume=True)

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

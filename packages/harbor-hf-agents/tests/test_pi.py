from __future__ import annotations

import json
from pathlib import Path

from harbor_hf_agents.pi.agent import pi_jsonl_to_atif_trajectory


def test_converts_pi_events_to_atif(tmp_path: Path) -> None:
    path = tmp_path / "pi.txt"
    events = [
        {"type": "session", "id": "session-1"},
        {
            "type": "message_end",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Fix the test."}],
            },
        },
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Done."},
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "write",
                        "arguments": {"path": "file.txt"},
                    },
                ],
                "usage": {"input": 10, "output": 2, "cacheRead": 3},
            },
        },
        {
            "type": "message_end",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-1",
                "content": [{"type": "text", "text": "ok"}],
            },
        },
    ]
    path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")

    trajectory = pi_jsonl_to_atif_trajectory(
        path,
        version="0.84.2",
        model_name="openai/model:provider",
    )
    assert trajectory is not None
    value = trajectory.to_json_dict()
    assert value["session_id"] == "session-1"
    assert value["steps"][1]["tool_calls"][0]["function_name"] == "write"
    assert value["steps"][1]["observation"]["results"][0]["content"] == "ok"
    assert value["final_metrics"]["total_prompt_tokens"] == 13


def test_returns_none_for_missing_or_incomplete_logs(tmp_path: Path) -> None:
    assert (
        pi_jsonl_to_atif_trajectory(
            tmp_path / "missing", version="0.84.2", model_name=None
        )
        is None
    )
    path = tmp_path / "partial"
    path.write_text("not json\n", encoding="utf-8")
    assert pi_jsonl_to_atif_trajectory(path, version="0.84.2", model_name=None) is None

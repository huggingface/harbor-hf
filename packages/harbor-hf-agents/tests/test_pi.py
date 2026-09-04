from __future__ import annotations

import json
from pathlib import Path

import pytest
from harbor.agents.model_connection import ResolvedModelConnection

from harbor_hf_agents.pi.agent import (
    PiAgent,
    build_provider_pinned_model,
    pi_jsonl_to_atif_trajectory,
)


def test_builds_provider_pin_from_pi_and_hugging_face_metadata() -> None:
    def fetch_json(url: str) -> object:
        if url.endswith("/providers/huggingface"):
            return [
                {
                    "id": "openai/gpt-oss-20b",
                    "name": "GPT OSS 20B",
                    "api": "openai-completions",
                    "reasoning": True,
                    "thinkingLevelMap": {"off": None, "high": "high"},
                    "input": ["text"],
                    "cost": {"input": 0.1, "output": 0.5},
                    "contextWindow": 131072,
                    "maxTokens": 32768,
                    "compat": {"supportsDeveloperRole": False},
                }
            ]
        assert url.endswith("/models/openai/gpt-oss-20b")
        return {
            "data": {
                "providers": [
                    {
                        "provider": "together",
                        "status": "live",
                        "supports_tools": True,
                        "pricing": {"input": 0.05, "output": 0.2},
                        "context_length": 131072,
                    }
                ]
            }
        }

    model = build_provider_pinned_model(
        "openai/gpt-oss-20b:together", fetch_json=fetch_json
    )

    assert model == {
        "id": "openai/gpt-oss-20b:together",
        "name": "GPT OSS 20B · together",
        "api": "openai-completions",
        "reasoning": True,
        "thinkingLevelMap": {"off": None, "high": "high"},
        "input": ["text"],
        "cost": {
            "input": 0.05,
            "output": 0.2,
            "cacheRead": 0,
            "cacheWrite": 0,
        },
        "contextWindow": 131072,
        "maxTokens": 32768,
        "compat": {"supportsDeveloperRole": False},
    }


@pytest.mark.parametrize(
    ("provider", "message"),
    [
        (
            {
                "provider": "together",
                "status": "error",
                "supports_tools": True,
                "pricing": {"input": 0.05, "output": 0.2},
                "context_length": 131072,
            },
            "not live",
        ),
        (
            {
                "provider": "together",
                "status": "live",
                "supports_tools": False,
                "pricing": {"input": 0.05, "output": 0.2},
                "context_length": 131072,
            },
            "does not support tools",
        ),
        (
            {
                "provider": "together",
                "status": "live",
                "supports_tools": True,
                "pricing": {"input": 0, "output": 0.2},
                "context_length": 131072,
            },
            "valid input price",
        ),
    ],
)
def test_rejects_unsafe_provider_metadata(
    provider: dict[str, object], message: str
) -> None:
    def fetch_json(url: str) -> object:
        if url.endswith("/providers/huggingface"):
            return [
                {
                    "id": "openai/gpt-oss-20b",
                    "api": "openai-completions",
                    "maxTokens": 32768,
                }
            ]
        return {"data": {"providers": [provider]}}

    with pytest.raises(RuntimeError, match=message):
        build_provider_pinned_model(
            "openai/gpt-oss-20b:together", fetch_json=fetch_json
        )


def test_supplies_provider_pin_to_pi_custom_model_config(tmp_path: Path) -> None:
    agent = PiAgent(logs_dir=tmp_path)
    agent._provider_model = {"id": "openai/gpt-oss-20b:together"}
    access = ResolvedModelConnection(
        provider="huggingface",
        api_key="test-only-placeholder",
        env={"HF_TOKEN": "test-only-placeholder"},
    )

    config = agent._build_custom_models_json(access, "openai/gpt-oss-20b:together")

    assert config == {
        "providers": {
            "harbor-endpoint": {
                "baseUrl": "https://router.huggingface.co/v1",
                "apiKey": "$HF_TOKEN",
                "api": "openai-completions",
                "models": [{"id": "openai/gpt-oss-20b:together"}],
            }
        }
    }


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

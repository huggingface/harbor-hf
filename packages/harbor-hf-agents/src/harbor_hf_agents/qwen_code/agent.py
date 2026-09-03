"""Qwen Code using Harbor's direct model connection."""

from harbor.agents.installed.qwen_code import QwenCode

from harbor_hf_agents.support.direct_inference import (
    DirectChatCompletionsAgent,
)


class QwenCodeAgent(DirectChatCompletionsAgent, QwenCode):
    """Harbor Qwen Code with direct OpenAI-compatible inference settings."""

    base_url_key = "OPENAI_BASE_URL"
    api_key_key = "OPENAI_API_KEY"
    agent_label = "Qwen Code"

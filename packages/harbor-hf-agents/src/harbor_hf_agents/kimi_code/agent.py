"""Kimi Code using Harbor's direct model connection."""

from harbor.agents.installed.kimi_code import KimiCode

from harbor_hf_agents.support.direct_inference import (
    MAX_OUTPUT_TOKENS_ENV,
    DirectChatCompletionsAgent,
    max_output_tokens,
)


class KimiCodeAgent(DirectChatCompletionsAgent, KimiCode):
    """Harbor Kimi Code with direct OpenAI-compatible inference settings."""

    base_url_key = "KIMI_MODEL_BASE_URL"
    api_key_key = "KIMI_MODEL_API_KEY"
    agent_label = "Kimi Code"

    def extend_inference_env(self, env: dict[str, str]) -> None:
        env["KIMI_MODEL_NAME"] = self.allowed_model_id()
        env["KIMI_MODEL_MAX_COMPLETION_TOKENS"] = str(
            max_output_tokens(env.get(MAX_OUTPUT_TOKENS_ENV))
        )

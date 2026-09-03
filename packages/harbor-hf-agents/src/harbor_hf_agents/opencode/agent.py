"""OpenCode using Harbor's direct model connection."""

import copy

from harbor.agents.installed.opencode import OpenCode

from harbor_hf_agents.support.direct_inference import (
    DirectChatCompletionsAgent,
)


class OpenCodeAgent(DirectChatCompletionsAgent, OpenCode):
    """Harbor OpenCode with direct OpenAI-compatible inference settings."""

    base_url_key = "OPENAI_BASE_URL"
    api_key_key = "OPENAI_API_KEY"
    agent_label = "OpenCode"
    _provider_npm = "@ai-sdk/openai-compatible"

    def _provider_model(self) -> tuple[str, str]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider, model_id = self.model_name.split("/", 1)
        return provider, model_id

    def allowed_model_id(self) -> str:
        return self._provider_model()[1]

    async def after_inference_prepared(self) -> None:
        """Write the direct base URL into OpenCode's provider options."""
        if self._inference_env is None:
            raise RuntimeError("OpenCode inference settings are not prepared")
        provider, model_id = self._provider_model()
        self._opencode_config = self._deep_merge(
            copy.deepcopy(self._opencode_config),
            {
                "provider": {
                    provider: {
                        "npm": self._provider_npm,
                        "models": {model_id: {}},
                        "options": {"baseURL": self._inference_env["OPENAI_BASE_URL"]},
                    }
                }
            },
        )
        self._opencode_config["provider"][provider]["models"][model_id] = {}

"""OpenCode over the Harbor-HF Job inference route."""

import copy

from harbor.agents.installed.opencode import OpenCode

from harbor_hf_agents.support.job_chat_completions import (
    JobChatCompletionsAgent,
)


class OpenCodeAgent(JobChatCompletionsAgent, OpenCode):
    """Harbor OpenCode bound to the locked Job loopback inference route.

    Upstream OpenCode reads ``OPENAI_API_KEY`` and ``OPENAI_BASE_URL`` from the
    Job process. Execution Jobs do not receive those values. This wrapper loads
    ``/run/harbor-hf-inference.json`` from the Job and injects the
    placeholder route into the agent process and ``opencode.json``.
    """

    route_base_url_key = "OPENAI_BASE_URL"
    route_api_key_key = "OPENAI_API_KEY"
    route_label = "OpenCode"
    _provider_npm = "@ai-sdk/openai-compatible"

    def _provider_model(self) -> tuple[str, str]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider, model_id = self.model_name.split("/", 1)
        return provider, model_id

    def allowed_model_id(self) -> str:
        return self._provider_model()[1]

    async def after_route_prepared(self) -> None:
        """Write the loopback base URL into OpenCode's provider options."""
        if self._route_env is None:
            raise RuntimeError("OpenCode inference route is not prepared")
        provider, model_id = self._provider_model()
        self._opencode_config = self._deep_merge(
            copy.deepcopy(self._opencode_config),
            {
                "provider": {
                    provider: {
                        "npm": self._provider_npm,
                        "models": {model_id: {}},
                        "options": {"baseURL": self._route_env["OPENAI_BASE_URL"]},
                    }
                }
            },
        )
        self._opencode_config["provider"][provider]["models"][model_id] = {}

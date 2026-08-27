"""FX over the Harbor-HF Job inference route."""

from harbor.agents.installed.fx import Fx

from harbor_hf_agents.support.job_chat_completions import (
    JobChatCompletionsAgent,
)


class FxAgent(JobChatCompletionsAgent, Fx):
    """Harbor FX bound to the locked Job loopback inference route.

    Upstream FX reads ``FX_GATEWAY_BASE_URL`` and ``AI_GATEWAY_API_KEY``
    from the Job process and talks to an OpenAI-compatible gateway. Execution
    Jobs do not receive that key.
    This wrapper loads ``/run/harbor-hf-inference.json`` and injects the
    placeholder Chat Completions route.
    """

    route_base_url_key = "FX_GATEWAY_BASE_URL"
    route_api_key_key = "AI_GATEWAY_API_KEY"
    route_label = "FX"
    install_packages = (
        "ca-certificates",
        "curl",
        "passwd",
        "tmux",
        "util-linux",
    )
    inject_route_into_process = True

    def _execution_model_name(self) -> str:
        return self.allowed_model_id()

    def extend_route_env(self, env: dict[str, str]) -> None:
        env["OPENAI_BASE_URL"] = env[self.route_base_url_key]
        env["OPENAI_API_KEY"] = env[self.route_api_key_key]
        env["VERCEL_AI_GATEWAY_API_KEY"] = env[self.route_api_key_key]

"""mini-swe-agent using Harbor's direct model connection."""

from harbor.agents.installed.mini_swe_agent import MiniSweAgent as HarborMiniSweAgent

from harbor_hf_agents.support.direct_inference import (
    DirectChatCompletionsAgent,
)


class MiniSweAgent(DirectChatCompletionsAgent, HarborMiniSweAgent):
    """Harbor mini-swe-agent with direct OpenAI-compatible inference settings."""

    base_url_key = "OPENAI_BASE_URL"
    api_key_key = "MSWEA_API_KEY"
    agent_label = "mini-swe-agent"
    install_packages = (
        "ca-certificates",
        "curl",
        "git",
        "passwd",
        "util-linux",
    )
    install_environment = (("UV_PYTHON", "3.12"),)
    inject_environment_into_process = True

    def extend_inference_env(self, env: dict[str, str]) -> None:
        env["OPENAI_API_BASE"] = env["OPENAI_BASE_URL"]
        # mini-swe-agent 2.4.6 passes provider credentials to LiteLLM, which
        # requires the provider-standard key even though Harbor reads MSWEA_API_KEY.
        env["OPENAI_API_KEY"] = env["MSWEA_API_KEY"]

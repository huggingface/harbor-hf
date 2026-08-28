"""mini-swe-agent over the Harbor-HF Job inference route."""

from harbor.agents.installed.mini_swe_agent import MiniSweAgent as HarborMiniSweAgent

from harbor_hf_agents.support.job_chat_completions import (
    JobChatCompletionsAgent,
)


class MiniSweAgent(JobChatCompletionsAgent, HarborMiniSweAgent):
    """Harbor mini-swe-agent bound to the locked Job loopback route.

    Upstream mini-swe-agent reads ``MSWEA_API_KEY`` and ``OPENAI_BASE_URL``
    from the Job process before it starts. Execution Jobs do not receive those
    values. This wrapper loads ``/run/harbor-hf-inference.json`` and injects
    the placeholder route into the process and the agent command.
    """

    route_base_url_key = "OPENAI_BASE_URL"
    route_api_key_key = "MSWEA_API_KEY"
    route_label = "mini-swe-agent"
    install_packages = (
        "ca-certificates",
        "curl",
        "git",
        "passwd",
        "util-linux",
    )
    install_environment = (("UV_PYTHON", "3.12"),)
    inject_route_into_process = True

    def extend_route_env(self, env: dict[str, str]) -> None:
        env["OPENAI_API_BASE"] = env["OPENAI_BASE_URL"]
        # mini-swe-agent 2.4.6 passes provider credentials to LiteLLM, which
        # requires the provider-standard key even though Harbor reads MSWEA_API_KEY.
        env["OPENAI_API_KEY"] = env["MSWEA_API_KEY"]

# Build the existing pinned Harbor CLI image first and supply its immutable digest.
ARG HARBOR_HF_CLI_IMAGE
FROM ${HARBOR_HF_CLI_IMAGE}

# The base image includes the locked Harbor and Hub dependencies.
COPY packages/harbor-hf-agents/src/harbor_hf_agents/runner.py /opt/runner/runner.py
CMD ["python", "/opt/runner/runner.py"]

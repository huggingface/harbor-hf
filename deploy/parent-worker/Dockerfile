FROM ghcr.io/astral-sh/uv:0.12.5@sha256:db2d5999728c5837e1bf9ba278ee6b05cef1e95e82a20e27b0c915cb4478b9d7 AS uv

FROM docker.io/library/python:3.12.14-slim-bookworm@sha256:356b0d18f9385f4bdcc673af60e1e64c9d1504952e4ec36ee32044c722a6bc4e

ENV PATH="/opt/harbor-hf-parent/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/harbor-hf-parent

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/* \
    && git --version

COPY --from=uv /uv /usr/local/bin/uv
COPY packages/harbor-hf-agents /opt/harbor-hf-agents

RUN uv sync \
        --project /opt/harbor-hf-agents \
        --frozen \
        --no-dev \
        --no-editable \
    && rm -rf /opt/harbor-hf-agents \
    && python --version \
    && python -c "import harbor, harbor_hf_agents, huggingface_hub"

WORKDIR /data
CMD ["python", "-m", "harbor_hf_agents.parent_worker"]

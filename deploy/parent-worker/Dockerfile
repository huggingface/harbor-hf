FROM ghcr.io/astral-sh/uv:0.12.5@sha256:db2d5999728c5837e1bf9ba278ee6b05cef1e95e82a20e27b0c915cb4478b9d7 AS uv

FROM docker.io/library/node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node

FROM docker.io/library/rust:1.96.1-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS pi-code-mode

ARG PI_CODE_MODE_REVISION=66bcfd51d54d8a1b7ab2bd9cb756b65874af9dda
ARG PI_CODE_MODE_VERSION=0.3.0

COPY --from=node /usr/local /usr/local

RUN git clone --filter=blob:none https://github.com/osolmaz/pi-code-mode.git /src/pi-code-mode \
    && cd /src/pi-code-mode \
    && git checkout "$PI_CODE_MODE_REVISION" \
    && test "$(git rev-parse HEAD)" = "$PI_CODE_MODE_REVISION" \
    && test "$(node -p 'require("./package.json").version')" = "$PI_CODE_MODE_VERSION" \
    && npm ci --ignore-scripts \
    && npm run build \
    && mkdir -p /opt/pi-code-mode \
    && npm pack --ignore-scripts --pack-destination /opt/pi-code-mode \
    && mv /opt/pi-code-mode/pi-code-mode-*.tgz /opt/pi-code-mode/pi-code-mode.tgz \
    && printf '%s\n' "$PI_CODE_MODE_REVISION" > /opt/pi-code-mode/REVISION \
    && sha256sum /opt/pi-code-mode/pi-code-mode.tgz > /opt/pi-code-mode/pi-code-mode.tgz.sha256 \
    && test -x dist/runtime/linux-x64/pi-code-mode-host

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
COPY --from=pi-code-mode /opt/pi-code-mode /opt/harbor-hf/pi-code-mode
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

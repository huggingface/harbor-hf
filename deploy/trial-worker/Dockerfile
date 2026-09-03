FROM ghcr.io/astral-sh/uv:0.12.5@sha256:db2d5999728c5837e1bf9ba278ee6b05cef1e95e82a20e27b0c915cb4478b9d7 AS uv

FROM docker.io/library/python:3.12.14-slim-bookworm@sha256:356b0d18f9385f4bdcc673af60e1e64c9d1504952e4ec36ee32044c722a6bc4e AS proot-builder

ARG PROOT_VERSION=5.4.0
ARG PROOT_REVISION=bd5a5f63
ARG PROOT_SHA256=29248aac2a7ce10c3bd5ee5602742ec33b2532310ff9cf73b79f3c133e5a5f68

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        gcc-multilib \
        libtalloc-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --silent --show-error \
        "https://github.com/proot-me/proot/archive/refs/tags/v${PROOT_VERSION}.tar.gz" \
        --output /tmp/proot.tar.gz \
    && echo "${PROOT_SHA256}  /tmp/proot.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/proot.tar.gz --directory /tmp \
    && make --directory "/tmp/proot-${PROOT_VERSION}/src" \
        "GIT_VERSION=v${PROOT_VERSION}" \
        "GIT_COMMIT=${PROOT_REVISION}" \
        loader.elf loader-m32.elf build.h \
    && make --directory "/tmp/proot-${PROOT_VERSION}/src" \
        "GIT_VERSION=v${PROOT_VERSION}" \
        "GIT_COMMIT=${PROOT_REVISION}" \
        proot \
    && make --directory "/tmp/proot-${PROOT_VERSION}/src" \
        "GIT_VERSION=v${PROOT_VERSION}" \
        "GIT_COMMIT=${PROOT_REVISION}" \
        DESTDIR=/opt/proot \
        install \
    && strip /opt/proot/usr/local/bin/proot \
    && /opt/proot/usr/local/bin/proot --version \
        | awk "/v${PROOT_VERSION}-${PROOT_REVISION}/ { found = 1 } END { exit !found }"

FROM docker.io/library/python:3.12.14-slim-bookworm@sha256:356b0d18f9385f4bdcc673af60e1e64c9d1504952e4ec36ee32044c722a6bc4e

# The final image digest, rather than mutable package metadata, is the reviewed
# worker identity recorded in deployment profiles.
ENV PATH="/opt/harbor-hf-runtime/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/harbor-hf-runtime

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        libtalloc2 \
        skopeo \
        umoci \
        util-linux \
        zstd \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg-query -W git libtalloc2 skopeo umoci util-linux zstd \
    && git --version \
    && setpriv --version \
    && skopeo --version \
    && umoci --version \
    && zstd --version

COPY --from=proot-builder /opt/proot/usr/local/bin/proot /usr/local/bin/proot
COPY --from=uv /uv /usr/local/bin/uv
COPY packages/harbor-hf-agents /opt/harbor-hf-agents

RUN uv sync \
        --project /opt/harbor-hf-agents \
        --frozen \
        --no-dev \
        --no-editable \
    && rm -rf /opt/harbor-hf-agents \
    && python --version \
    && python -c "import harbor, harbor_hf_agents" \
    && python -c "from harbor_hf_agents.command_agent.agent import CommandAgent, CommandAgentConfig; assert CommandAgent.name() == 'command-agent'; assert CommandAgentConfig.__name__ == 'CommandAgentConfig'" \
    && proot --version \
    && uv --version

WORKDIR /workspace

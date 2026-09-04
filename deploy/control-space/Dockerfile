FROM node:22.22.0-bookworm@sha256:2e3d655fd1e3ffaa6b5f23ee9f3905a0fd9e8c0a65df94c8ae6e4d18a0f48870 AS build

# Production omit skips Playwright, Vitest, and Biome. Prefer IPv4 and retry
# transient registry failures while fetching only from the public registry.
ENV NODE_ENV=production \
    HOME=/tmp \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    npm_config_cache=/tmp/npm-cache \
    npm_config_userconfig=/tmp/npmrc \
    npm_config_registry=https://registry.npmjs.org/ \
    npm_config_replace_registry_host=always \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json tsconfig.space.json .npmrc ./
COPY apps/control-api/package.json apps/control-api/package.json
COPY apps/control-web/package.json apps/control-web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/control-core/package.json packages/control-core/package.json
COPY packages/hf-adapters/package.json packages/hf-adapters/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
# Keep the npm log in the Space build output when the installer aborts.
RUN npm ci --omit=dev --no-audit --no-fund --foreground-scripts \
    || (for log in /tmp/npm-cache/_logs/*-debug-0.log /root/.npm/_logs/*-debug-0.log; do \
          if [ -f "$log" ]; then echo "--- $log ---"; cat "$log"; fi; \
        done; exit 1)

COPY apps/control-api apps/control-api
COPY apps/control-web apps/control-web
COPY packages packages
COPY profiles profiles
COPY scripts/control-service/control-smoke-worker.cjs scripts/control-service/control-smoke-worker.cjs
# Tests and schema generation run in CI. The image compiles the committed
# sources so a Space rebuild is not blocked on the Vitest suite.
RUN npm run typecheck:space \
    && npm run build -w @harbor-hf/control-web \
    && npm prune --omit=dev --workspaces \
    && rm -rf node_modules/@harbor-hf/test-fixtures

FROM node:22.22.0-bookworm-slim@sha256:7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3 AS runtime

ARG HARBOR_HF_SOURCE_REVISION=development
ENV NODE_ENV=production \
    HARBOR_HF_STORE_MODE=bucket \
    HARBOR_HF_SOURCE_REVISION=${HARBOR_HF_SOURCE_REVISION}
LABEL org.opencontainers.image.revision=${HARBOR_HF_SOURCE_REVISION}
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/control-api/package.json ./apps/control-api/package.json
COPY --from=build --chown=node:node /app/apps/control-api/dist ./apps/control-api/dist
COPY --from=build --chown=node:node /app/apps/control-api/node_modules ./apps/control-api/node_modules
COPY --from=build --chown=node:node /app/apps/control-web/package.json ./apps/control-web/package.json
COPY --from=build --chown=node:node /app/apps/control-web/dist ./apps/control-web/dist
COPY --from=build --chown=node:node /app/apps/control-web/node_modules ./apps/control-web/node_modules
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/contracts/schemas ./packages/contracts/schemas
COPY --from=build --chown=node:node /app/packages/control-core/package.json ./packages/control-core/package.json
COPY --from=build --chown=node:node /app/packages/control-core/dist ./packages/control-core/dist
COPY --from=build --chown=node:node /app/packages/hf-adapters/package.json ./packages/hf-adapters/package.json
COPY --from=build --chown=node:node /app/packages/hf-adapters/dist ./packages/hf-adapters/dist
COPY --from=build --chown=node:node /app/profiles ./profiles

RUN npm ls --omit=dev --all
USER node
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:7860/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/control-api/dist/main.js"]

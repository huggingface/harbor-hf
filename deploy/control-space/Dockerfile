FROM node:22.22.0-bookworm@sha256:2e3d655fd1e3ffaa6b5f23ee9f3905a0fd9e8c0a65df94c8ae6e4d18a0f48870 AS build

ENV NODE_ENV=development
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json biome.json vitest.config.ts ./
COPY apps/control-api/package.json apps/control-api/package.json
COPY apps/control-web/package.json apps/control-web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/control-core/package.json packages/control-core/package.json
COPY packages/hf-adapters/package.json packages/hf-adapters/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
RUN npm ci

COPY apps/control-api apps/control-api
COPY apps/control-web apps/control-web
COPY packages packages
COPY profiles profiles
COPY docs docs
RUN npm run generate \
    && npm run typecheck \
    && npm test -- --maxWorkers=1 --no-file-parallelism --testTimeout=30000 \
    && npm run build -w @harbor-hf/control-web \
    && npm prune --omit=dev --workspaces

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
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/contracts/schemas ./packages/contracts/schemas
COPY --from=build --chown=node:node /app/packages/control-core/package.json ./packages/control-core/package.json
COPY --from=build --chown=node:node /app/packages/control-core/dist ./packages/control-core/dist
COPY --from=build --chown=node:node /app/packages/hf-adapters/package.json ./packages/hf-adapters/package.json
COPY --from=build --chown=node:node /app/packages/hf-adapters/dist ./packages/hf-adapters/dist
COPY --from=build --chown=node:node /app/profiles ./profiles

USER node
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:7860/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/control-api/dist/main.js"]

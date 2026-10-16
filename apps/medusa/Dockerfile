# Build from repository root: docker build -f apps/medusa/Dockerfile .
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/medusa/package.json apps/medusa/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/commerce/package.json packages/commerce/package.json
COPY services/image-processing/package.json services/image-processing/package.json
COPY design/reference/package.json design/reference/package.json

FROM manifests AS build
RUN npm ci --workspace=@vynvori/medusa --include-workspace-root=false --no-audit --no-fund
COPY apps/medusa apps/medusa
RUN npm run build --workspace=@vynvori/medusa

FROM manifests AS dependencies
RUN npm ci --omit=dev --workspace=@vynvori/medusa --include-workspace-root=false --no-audit --no-fund && npm cache clean --force

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production PORT=8080 MEDUSA_DISABLE_TELEMETRY=true
WORKDIR /app/apps/medusa/.medusa/server
COPY --from=dependencies --chown=node:node /app /app
COPY --from=build --chown=node:node /app/apps/medusa/.medusa/server ./
COPY --chown=node:node apps/medusa/scripts/container.mjs /app/container.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/container.mjs"]
CMD ["serve"]

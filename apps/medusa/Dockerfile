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

# Keep compiler/npm tooling above. Runtime needs the verified Node binary and
# glibc/C++ libraries only; no shell, npm/Yarn, Perl or package manager is copied.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2 AS runtime
ENV NODE_ENV=production NODE_VERSION=22.23.3 PORT=8080 MEDUSA_DISABLE_TELEMETRY=true
WORKDIR /app/apps/medusa/.medusa/server
COPY --from=manifests /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies --chown=65532:65532 /app /app
COPY --from=build --chown=65532:65532 /app/apps/medusa/.medusa/server ./
COPY --chown=65532:65532 apps/medusa/scripts/container.mjs /app/container.mjs
COPY --chown=65532:65532 apps/medusa/scripts/remote-staging.mjs apps/medusa/scripts/remote-staging-policy.json /app/
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/app/container.mjs"]
CMD ["serve"]

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node-binary
# Same pinned Node binary and minimal libc runtime as the reviewed Medusa image.
# No npm, Yarn, shell or package-manager dependencies enter the worker runtime.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
ENV NODE_ENV=production NODE_VERSION=22.23.3 PORT=8080 M2_CONTAINER=1
WORKDIR /app
COPY --from=node-binary /usr/local/bin/node /usr/local/bin/node
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 src ./src
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["src/server.mjs"]

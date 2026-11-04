FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /build
COPY scripts/build-runtime.ts scripts/build-runtime.ts
COPY src src
COPY packages/relay-protocol/src packages/relay-protocol/src
RUN bun scripts/build-runtime.ts

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
LABEL org.opencontainers.image.source="https://github.com/CherryHQ/relay-server"
WORKDIR /app
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=8787
COPY --from=build --chown=bun:bun /build/dist/runtime/main.js /app/main.js
USER bun
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + process.env.RELAY_PORT + '/healthz', {signal: AbortSignal.timeout(2000)}); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "/app/main.js"]

FROM oven/bun:1.4.4-slim AS web
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && VITE_ZERO_URL=/zero bun run --cwd apps/web build

FROM oven/bun:1.4.4-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production && rm -rf /root/.bun/install/cache
COPY --from=web /app/apps/web/dist apps/web/dist
ARG SPYRIA_AGENT_IMAGE=
ENV SPYRIA_ENV=production SPYRIA_WEB_DIST=/app/apps/web/dist PORT=3000 SPYRIA_AGENT_IMAGE=${SPYRIA_AGENT_IMAGE}
USER bun
EXPOSE 3000
CMD ["bun", "apps/server/src/index.ts"]

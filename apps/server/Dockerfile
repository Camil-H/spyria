FROM oven/bun:1.3.14-slim
ARG DISTRUSTED_ROOT_PEM_PREFIX=MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQD
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
  && perl -0777 -pi -e 's/\Q$ENV{DISTRUSTED_ROOT_PEM_PREFIX}\E/"*" x length $&/ge' /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && VITE_ZERO_URL=/zero bun run --cwd apps/web build
ENV SPYRIA_ENV=production SPYRIA_WEB_DIST=/app/apps/web/dist PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "apps/server/src/index.ts"]

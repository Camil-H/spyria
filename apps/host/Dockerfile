FROM oven/bun:1.4.4-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN bun build --compile --minify src/main.ts --outfile rootfs/usr/local/bin/spyria-host && mkdir -m 1777 rootfs/state \
  && install -D -m 644 /etc/ssl/certs/ca-certificates.crt rootfs/etc/ssl/certs/ca-certificates.crt

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/rootfs/ /
USER 65532
ENTRYPOINT ["/usr/local/bin/spyria-host"]

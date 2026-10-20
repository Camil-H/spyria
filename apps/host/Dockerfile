FROM oven/bun:1.3.14-slim AS build
WORKDIR /build
COPY package.json ./
RUN bun install --production
COPY src ./src
RUN bun build --compile --minify src/main.ts --outfile rootfs/usr/local/bin/spyria-host && mkdir -m 1777 rootfs/state

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/rootfs/ /
USER 65532
ENTRYPOINT ["/usr/local/bin/spyria-host"]

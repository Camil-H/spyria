# 0026. Published images and one entry point

## Context

Installing Spyria meant a clone, Bun, building the runtime image on the machine and copying it to every host, and a proxy that routed `/zero/*` to zero-cache before everything else to the server. Each of those is a step to get wrong, and none of them is what a self-hoster wants to do. A one-step install needs images anyone can pull and a way in with a single target.

## Decision

- Every version tag (`v1.2.3`) publishes `spyria-server`, `spyria-host` and `spyria-agent` to GHCR for `linux/amd64` and `linux/arm64`, tagged with the version and `latest`, signed with cosign (keyless, from the Publish workflow). The runtime image's licenses are checked before anything is pushed.
- The server image carries the runtime image of its own version by digest (`SPYRIA_AGENT_IMAGE`), so a deployment runs the runtime image that was tested with it. A host pulls that image from the deployment's registry when it is missing, and accepts nothing else from the server: only `<registry>/spyria-agent@sha256:<digest>` of the namespace its own image came from (`SPYRIA_IMAGES`), or a local content ID for builds from a clone.
- The server forwards `/zero/*` to zero-cache, HTTP and WebSocket alike, streamed both ways. The way in routes the one hostname to `server:3000`, and `/health` reports zero-cache like the gateway.
- `deploy/compose.prod.yml` runs the published images of `SPYRIA_VERSION`; `deploy/compose.build.yml` is the override that builds from a clone, for development and `smoke:prod`.

## Consequences

- Installing is downloading three files and `docker compose up`; upgrading is changing `SPYRIA_VERSION` and pulling.
- The first runtime on a host waits for the pull of the runtime image.
- Development keeps Vite's own proxy and local images with content IDs; nothing is pulled there.
- The proxy guidance is now one line, and the sync WebSocket crosses the server process: a server restart reconnects every client, as it already did for agent streams.

See [self-hosting](../guides/self-hosting.md) and [decision 0017](0017-one-compose-file-one-origin.md).

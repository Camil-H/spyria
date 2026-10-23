# 0017. One Compose file and one origin

## Context

Self-hosters range from one person on a spare machine to a team with its own platform. Spyria has several processes (server, zero-cache, gateway, Postgres, migrations, optional host) and a web app. Several origins would mean cross-origin cookies and more routing to get wrong.

## Decision

- One Docker Compose file, `deploy/compose.prod.yml`, runs a production instance, reading `.env.prod`. Optional services sit behind Compose profiles: `host` (a runtime host on the same machine) and `cloudflare` (a Cloudflare tunnel).
- The server serves the built web app itself, so the app, the API, sign-in and webhooks share one HTTPS origin. Only `/zero/*` goes to zero-cache.
- A `migrate` service applies migrations, and the server starts only after it succeeds.
- The server refuses to start in production until its settings pass a check, listing every problem at once.
- The docs stay provider-neutral: any HTTPS front, any OIDC provider, any SMTP service. Cloudflare appears as one worked example.

## Consequences

- Install and upgrade are the same command.
- Cookies are first-party and the session model stays simple.
- Scaling past one server process is not supported yet: live streams, host connections and rate limits live in that process.

See [self-hosting](../guides/self-hosting.md).

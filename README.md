# HQ

Org-agnostic, model-agnostic AI workspace: agent chats, dev sessions and knowledge.

## Prerequisites

- Bun 1.3
- Node 24 (zero-cache and Vite run on it)
- Docker (Compose project `hq`: Postgres on 5434, Dex on 5556, zero-cache on 4848)

## First run

```sh
bun install
bun run db:migrate    # starts Postgres and Dex if needed
bun run db:seed       # skips when the data is already there
bun run dev           # adds zero-cache, then the server on 3000 and the app on http://localhost:5173
```

Migrate and seed before the first `bun run dev`: zero-cache needs the `hq_zero` publication the migrations create.

## Signing in locally

The app signs in through Dex in a popup (allow popups for `localhost:5173`). The Dex users all have the password `password`:

- `alice@example.com`: member of Acme and Globex
- `bob@example.com`: member of Acme
- `nina@example.com`: no membership (shows the "not invited" screen)

`bun run dev` sets dev values for `HQ_TOKEN_SECRET`, `HQ_OIDC_ISSUER`, `HQ_OIDC_CLIENT_ID`, `HQ_OIDC_REDIRECT_URI` and `HQ_APP_ORIGIN`; the server refuses to start without them.

## Day to day

```sh
bun run dev           # stack, server and app
bun run db:migrate    # after pulling new migrations
bun run db:reset      # wipe the data and seed again
bun run db:rebuild-messages [--chat <id>]   # rebuild the messages projection from the events
bun run jobs:failed                         # list dead jobs with their last error
bun run jobs:retry <id>|--all               # requeue dead jobs with their attempts reset
bun run stack:down    # stop the containers (data is kept in the volume)
```

## Checks

```sh
bun run check:all          # everything below in order, failing fast; starts Postgres and Dex, leaves the stack running
bun run typecheck
bun run test
bun run test:integration   # needs bun run stack:up
bun run check:boundaries
bun run lint
bun run check:bundle       # builds the app, main chunk at most 720 kB, no new server-only SQL
bun run test:e2e           # starts its own stack per worker
```

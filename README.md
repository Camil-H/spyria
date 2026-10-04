# HQ

Org-agnostic, model-agnostic AI workspace: agent chats, dev sessions and knowledge.

## Prerequisites

- Bun 1.3
- Node 24 (zero-cache and Vite run on it)
- Docker (Compose project `hq`: Postgres on 5434, Dex on 5556, zero-cache on 4848)

## First run

```sh
bun install
bun run stack:up      # Postgres and Dex
bun run db:migrate
bun run db:seed       # once: the seed is not idempotent
bun run dev           # adds zero-cache, then the server on 3000 and the app on http://localhost:5173
```

Migrate and seed before the first `bun run dev`: zero-cache needs the `hq_zero` publication the migrations create.

## Day to day

```sh
bun run dev           # stack, server and app
bun run db:migrate    # after pulling new migrations
bun run db:reset      # wipe the data and seed again
bun run stack:down    # stop the containers (data is kept in the volume)
```

## Checks

```sh
bun run typecheck
bun run test
bun run test:integration   # needs bun run stack:up
bun run check:boundaries
bun run lint
bun run test:e2e           # starts its own stack per worker
```

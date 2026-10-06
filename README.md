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

## Adding a runtime host for dev

Runtimes (Agent Servers) run on runtime hosts: any machine with Docker running the `hq-host` container, which dials out to HQ.

```sh
docker build -t hq-host apps/host
```

Then, signed in as a workspace admin (Alice), open the workspace menu, **Workspace settings**, **Add runtime host**, give it a name and copy the command. On a Mac (OrbStack or Docker Desktop), switch **Rootless Docker** off, and in the copied command replace `localhost` with `host.docker.internal` (the container cannot reach the Mac's `localhost`) and `$(stat -c %g /var/run/docker.sock)` with `0`. The row turns Online within seconds. The first runtime pulls the Agent Server image (about 1.2 GB).

Without Docker for `hq-host` itself, run it as a process against the local Docker: `HQ_HOST_STATE_DIR=.hq-host bun apps/host/src/main.ts http://localhost:5173/h/<code>`. Remove the host in the settings page when done, then `docker rm -f hq-host` and `docker volume rm hq-host`.

With a host online, a prompt in a runtime chat starts that chat's Agent Server and the agent answers. Until the gateway exists, the model is a fake LLM served by the dev server itself at `/fake-llm/v1` (it answers "Understood, working on it."); Agent Servers reach it at `http://host.docker.internal:3000/fake-llm/v1`. Set `HQ_LLM_BASE_URL` (and `HQ_LLM_MODEL`, default `openai/fake`) to point them at another OpenAI-compatible endpoint; the fake LLM is then not mounted.

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
bun run check:bundle       # builds the app, main chunk at most 760 kB, one React, no server-only SQL
bun run test:e2e           # starts its own stack per worker
```

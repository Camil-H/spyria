# HQ

Org-agnostic, model-agnostic AI workspace: agent chats, dev sessions and knowledge.

## Prerequisites

- Bun 1.3
- Node 24 (zero-cache and Vite run on it)
- Docker (Compose project `hq`: Postgres on 5434, Dex on 5556, zero-cache on 4848, the model gateway on 127.0.0.1:8180)

## First run

```sh
bun install
bun run db:migrate    # starts Postgres and Dex if needed
bun run db:seed       # skips when the data is already there
bun run dev           # adds zero-cache and the model gateway, then the server on 3000 and the app on http://localhost:5173
```

Migrate and seed before the first `bun run dev`: zero-cache needs the `hq_zero` publication the migrations create.

## Signing in locally

The app signs in through Dex in a popup (allow popups for `localhost:5173`). The Dex users all have the password `password`:

- `alice@example.com`: member of Acme and Globex
- `bob@example.com`: member of Acme
- `nina@example.com`: no membership (shows the "not invited" screen)

`bun run dev` sets dev values for `HQ_TOKEN_SECRET`, `HQ_OIDC_ISSUER`, `HQ_OIDC_CLIENT_ID`, `HQ_OIDC_REDIRECT_URI`, `HQ_APP_ORIGIN`, `HQ_GATEWAY_URL`, `HQ_GATEWAY_ADMIN_USER` and `HQ_GATEWAY_ADMIN_PASSWORD`; the server refuses to start without them.

## Adding a runtime host for dev

Runtimes (Agent Servers) run on runtime hosts: any machine with Docker running the `hq-host` container, which dials out to HQ.

```sh
docker build -t hq-host apps/host
```

Then, signed in as a workspace admin (Alice), open the workspace menu, **Workspace settings**, **Add runtime host**, give it a name and copy the command. On a Mac (OrbStack or Docker Desktop), switch **Rootless Docker** off, and in the copied command replace `localhost` with `host.docker.internal` (the container cannot reach the Mac's `localhost`) and `$(stat -c %g /var/run/docker.sock)` with `0`. The row turns Online within seconds. The first runtime pulls the Agent Server image (about 1.2 GB).

Without Docker for `hq-host` itself, run it as a process against the local Docker: `HQ_HOST_STATE_DIR=.hq-host bun apps/host/src/main.ts http://localhost:5173/h/<code>`. Remove the host in the settings page when done, then `docker rm -f hq-host` and `docker volume rm hq-host`.

With a host online, a prompt in a runtime chat starts that chat's Agent Server and the agent answers. Agent Servers call the model through their host: `hq-host` relays `/v1/*` (at `http://hq-gateway-relay:4000/v1` on the runtime network) to HQ, which runs each call on the prompting member's key in the gateway. Rebuild the `hq-host` image after pulling this change (`docker build -t hq-host apps/host`, then recreate the container), or its runtimes cannot reach a model.

## The model gateway

`bun run dev` starts `hq-gateway` (Bifrost, pinned by digest, config in `infra/bifrost.json`) on `127.0.0.1:8180`. Its first start runs the one-shot `hq-gateway-database` container, which creates a `bifrost` role and database on `hq-postgres` (outside HQ's migrations); its own data lives in the `hq-gateway-data` volume. Members' API keys are stored in the gateway only: HQ keeps a reference and the last 4 characters. Dev secrets come from `HQ_GATEWAY_ENCRYPTION_KEY`, `HQ_GATEWAY_SETUP_TOKEN`, `HQ_GATEWAY_ADMIN_USER`, `HQ_GATEWAY_ADMIN_PASSWORD` and `HQ_GATEWAY_DB_PASSWORD` (dev defaults in `infra/docker-compose.yml`); the encryption key can never change without wiping the gateway's database.

Keys added before the gateway existed, including Alice's seeded Anthropic key, are not in it: remove and re-add them in the profile, or prompts are refused. Supported providers are OpenAI, Anthropic, Mistral and Fake. Without real keys, add a key with provider `Fake` and any secret (a secret containing `refused` is refused, to try the error path): the dev server registers its fake LLM (`/fake-llm`) as the gateway's `fake` provider, and Agent Servers use `openai/fake/fake-model` unless `HQ_LLM_MODEL` is set (for example `openai/anthropic/claude-sonnet-4-5` with an Anthropic key); with `HQ_LLM_MODEL` set the fake LLM is not mounted.

## Day to day

```sh
bun run dev           # stack, server and app
bun run db:migrate    # after pulling new migrations
bun run db:reset      # wipe the data and seed again
bun run db:rebuild-messages [--chat <id>]   # rebuild the messages projection from the events
bun run jobs:failed                         # list dead jobs with their last error
bun run jobs:retry <id>|--all               # requeue dead jobs with their attempts reset
bun run stack:down    # stop the containers, the gateway included (data is kept in the volumes)
```

## Checks

```sh
bun run check:related      # while iterating: lint, typecheck and boundaries, then only the affected tests (see below)
bun run check:all          # everything below in order, failing fast; starts Postgres and Dex (not the gateway), leaves the stack running
bun run check:all --verify # does the last check:all match the current tree, and did it pass?
bun run typecheck
bun run test
bun run test:integration   # needs bun run stack:up; runs its own gateway (hq-test-gateway-integration on 4880)
bun run check:boundaries
bun run lint
bun run check:bundle       # builds the app, main chunk at most 760 kB, one React, no server-only SQL
bun run test:e2e           # starts its own stack per worker and one gateway (hq-test-gateway-e2e on 4881)
```

`check:related [--base <ref>]` takes the uncommitted changes plus the commits since `<ref>` (default `HEAD`). It runs the unit and integration test files that changed or import a changed module, directly or not (dependency-cruiser's graph), and Playwright `--only-changed=<ref>` when a spec imports a changed module. It prints what it selected and why. It runs a whole suite when it cannot decide: a changed file outside the module graph (lock file, config, SQL, infra) runs every suite, `integration-setup.ts` runs every integration test, and an e2e harness file (`test-server.ts`, `testing.ts`, the fake LLM and Agent Server, `global-setup.ts`, `playwright.config.ts`) runs the whole e2e suite. App code that e2e reaches only through the servers is left to `check:all`.

`check:all` writes its full output to `.check/last-check-all.log` and a summary to `.check/last-check-all.json`: the `git stash create` fingerprint (HEAD when the tree is clean), HEAD, the tree hash of the working tree including untracked files, the exit code, and each step's result and duration. `--verify` compares that tree hash with the current tree.

e2e tests talk to a fake Agent Server by default (`agentServer: 'fake'`): the test server connects one fake runtime host per worker database, and its Agent Server runs the same fake LLM scripts through the real relay and gateway, running commands with `bash` and editing files in a temporary directory. Tests marked `test.use({ agentServer: 'real' })` pair a real `hq-host` with Docker Agent Servers on their worker the first time one runs there. That smoke set is runtime-ui 2 (cold start end to end), agent-bridge 2 (streamed reply), agent-steps 14 (real shell commands, exit 0 and exit 3), runtime-ui 6 (Stop), runtime-ui 3 (resume after the idle stop) and gateway 2 (one prompt per member key through the relay and Bifrost); run it alone with `bun run test:e2e --grep "real Agent Server"`.

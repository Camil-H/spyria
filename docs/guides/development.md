# Development

This guide takes you from a fresh clone to a running Spyria on your machine: the web app, the server, the sync layer, the model gateway and, when you need agents, a runtime host. It also lists the commands you use every day and where to start reading the code. For the test suites, see [Testing](./testing.md); for a production deployment, see [Self-hosting](./self-hosting.md).

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Bun | 1.4.4 | Runs the server, the scripts and the tests. It is the version of the Dockerfiles: `agent:build` compiles spyria-agent with it and the docker tests run on it. |
| Node | 24 | zero-cache and Vite run on it (`engines` in `package.json` allows `>=24 <25`). |
| Docker | with Compose | Runs the dev stack (Postgres, Dex, zero-cache, the gateway) and, later, runtimes. |

The dev stack is the Compose project in `infra/docker-compose.yml`. Its containers are named `spyria-*`:

| Service | Container | Port |
|---|---|---|
| Postgres 18 | `spyria-postgres` | 5434 |
| Dex (dev identity provider) | `spyria-dex` | 5556 |
| zero-cache (profile `zero`) | `spyria-zero-cache` | 4848 |
| Model gateway, Bifrost (profile `gateway`) | `spyria-gateway` | 127.0.0.1:8180 |

Tests never use this stack: they start their own containers, named `spyria-test-*` (see [Testing](./testing.md#test-infrastructure)).

## First run

```sh
bun install
bun run db:migrate    # starts Postgres and Dex if needed, then applies the migrations
bun run db:seed       # seeds the demo data; skips when the data is already there
bun run dev           # adds zero-cache and the gateway, then the server on 3000 and the app on http://localhost:5173
```

Migrate before the first `bun run dev`: zero-cache replicates through the `spyria_zero` publication that the migrations create, and it cannot start without it.

## Signing in locally

In development the app signs in through Dex in a popup, so allow popups for `localhost:5173`. The Dex users (`infra/dex.yaml`) all have the password `password`:

| User | What you see |
|---|---|
| `alice@example.com` | Admin of the Acme and Globex workspaces |
| `bob@example.com` | Member of Acme |
| `nina@example.com` | No membership: the "not invited" screen |

The seed adds no model API key. To prompt an agent, add a real provider key (OpenAI, Anthropic, Mistral or another provider the gateway supports) in Profile. The fake LLM in `apps/server/src/testing/fake-llm.ts` is mounted by the test servers only.

## Settings and `.env.dev`

The server refuses to start without `SPYRIA_TOKEN_SECRET`, `SPYRIA_SECRETS_KEY`, `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID`, `SPYRIA_OIDC_REDIRECT_URI`, `SPYRIA_APP_ORIGIN`, `SPYRIA_GATEWAY_URL`, `SPYRIA_GATEWAY_ADMIN_USER` and `SPYRIA_GATEWAY_ADMIN_PASSWORD`. `bun run dev` sets a dev value for each one (a random token secret per start, and a fixed secrets key so runtimes keep working across restarts), so nothing is needed to get going.

Every setting is listed with its dev default and a comment in `.env.example`. To change one, copy it to `.env.dev`: `bun run dev` and `bun run operator` read that file. Production reads `.env.prod` instead (see [Self-hosting](./self-hosting.md)). Both files are git-ignored.

## The model gateway in development

`bun run dev` starts `spyria-gateway` (Bifrost, pinned by digest, configured by `infra/bifrost.json`) on `127.0.0.1:8180`. On its first start, the one-shot `spyria-gateway-database` container creates a `bifrost` role and database on `spyria-postgres`, outside Spyria's migrations. The gateway's own data lives in the `spyria-gateway-data` volume.

Members' API keys are stored in the gateway only; Spyria keeps a reference and the last 4 characters. The gateway's dev secrets come from `SPYRIA_GATEWAY_ENCRYPTION_KEY`, `SPYRIA_GATEWAY_SETUP_TOKEN`, `SPYRIA_GATEWAY_ADMIN_USER`, `SPYRIA_GATEWAY_ADMIN_PASSWORD` and `SPYRIA_GATEWAY_DB_PASSWORD`, with dev defaults in `infra/docker-compose.yml`. The encryption key can never change without wiping the gateway's database, because every stored key is encrypted with it.

## Tools (MCP servers) in development

Members connect tools in Profile > Connections > My connections. The agent of a runtime chat calls them through the runtime host's relay (`/mcp`) and the gateway, always as the chat owner. The OAuth token stays in the gateway, against the member's virtual key in that workspace, which Spyria creates when the member first needs tools, with or without an LLM key; Spyria stores only the server name and a status. See [Agents](../features/agents.md) for how members use them.

A tool server is set up once per deployment before members see it:

1. **GitHub:** create a GitHub OAuth App (GitHub Settings > Developer settings > OAuth Apps) with the callback URL `http://localhost:5173/gateway-oauth/api/oauth/callback` (GitHub needs an exact match; in production use your origin). Then run:

   ```sh
   GITHUB_MCP_CLIENT_ID=<client id> GITHUB_MCP_CLIENT_SECRET=<client secret> bun run tools:setup github
   ```

   The scopes are `repo read:org read:user`. The secret goes to the gateway, encrypted there, never to Spyria's database.
2. **Notion:** nothing to register (the gateway registers itself with Notion's MCP server):

   ```sh
   bun run tools:setup notion
   ```

3. Each setup prints a login URL. Open it, log in once with your own account (the gateway uses it only to discover the server's tools), approve, then press Enter.

The OAuth redirect goes through Spyria's origin: the gateway's external client URL is `SPYRIA_GATEWAY_OAUTH_BASE` (default `http://localhost:5173/gateway-oauth`, which Vite proxies to the server). After changing it, recreate the gateway and set the servers up again:

```sh
docker compose -f infra/docker-compose.yml --profile gateway up -d --force-recreate gateway
```

Disconnecting a tool in the profile deletes the gateway's token only. The gateway keeps the provider's token encrypted and never returns it, and it calls no revocation endpoint, so Spyria cannot revoke the grant upstream; after a disconnect the profile tells the member to remove it at the provider (GitHub Settings > Applications, Notion > Connections).

## Day to day

```sh
bun run dev                                  # stack, server and app
bun run db:migrate                           # after pulling new migrations
bun run db:reset                             # wipe the data and seed again
bun run db:rebuild-messages [--chat <id>]    # rebuild the messages projection from the events
bun run jobs:failed                          # list dead jobs with their last error
bun run jobs:retry <id>|--all                # requeue dead jobs with their attempts reset
bun run stack:down                           # stop the containers, the gateway included; data stays in the volumes
```

After a migration that changes what zero-cache replicates (a table added to or removed from the publication), restart zero-cache so it picks up the new publication: `docker restart spyria-zero-cache`.

When you change the database schema, generate the migration with Drizzle Kit and regenerate the Zero schema:

```sh
bun run --cwd packages/db generate
bun run db:generate-zero
```

Check a generated migration by hand, and never edit a migration that has shipped.

## Operator commands

`bun run operator <command>` runs `apps/server/src/operator-cli.ts` against the database and gateway in `.env.dev` (or the environment). The short scripts above are aliases of it.

| Command | Alias | What it does |
|---|---|---|
| `rebuild-messages [--chat <id>]` | `db:rebuild-messages` | Rebuilds the messages projection from the event store. |
| `failed-jobs` | `jobs:failed` | Lists jobs that exhausted their attempts, with the last error. |
| `retry-jobs <id>\|--all` | `jobs:retry` | Requeues failed jobs with their attempts reset. |
| `tools-setup github\|notion` | `tools:setup` | Sets up a tool server in the gateway (above). |
| `sso:verify-domain --workspace <id> --domain <domain>` | none | Verifies a workspace's sign-in domain without email (see [Self-hosting](./self-hosting.md)). |

## Running agents locally: a runtime host

Agents run in runtimes (containers of Spyria's runtime image with spyria-agent) on runtime hosts: any machine with Docker running the host program `spyria-host`, which dials out to Spyria. For the concepts, see [Machines](../features/machines.md).

### Build the runtime image

Runtime hosts never pull images. Build Spyria's runtime image before the first runtime:

```sh
bun run agent:build          # compile spyria-agent and build the image; cached by Docker
bun run agent:versions       # pinned versus latest on npm, per tool
bun run agent:bump <tool>    # pin the latest of claude-code | claude-agent-acp | codex | codex-acp | pi | playwright, then rebuild
```

The image (`apps/agent`) holds spyria-agent with Pi, node and npm, git and ripgrep, and for `take_screenshot` playwright-core with the system libraries Chromium needs. Pi is pinned in `apps/agent/pi/package.json` and playwright-core in `apps/agent/browser/package.json`, each with its `package-lock.json` and installed with `npm ci`; `agent:bump pi` and `agent:bump playwright` regenerate those lockfiles. The image build also installs Chromium's headless shell next to playwright-core (about 280 MB), so a runtime takes screenshots without downloading anything or reaching the internet.

Claude Code, Codex and their ACP adapters are never in the image. They are pinned in `apps/host/src/harnesses.json`, and a member's `spyria-host` installs them on that machine on first use (at `login`, or when a session starts, the chat showing "Installing Claude Code…") into the `spyria-harnesses` volume, one folder per pinned set, mounted read-only into the sessions. `SPYRIA_HARNESS_REGISTRY` points the install at another npm registry.

`agent:build` writes the image's content ID to `apps/agent/image-id`. The server reads it at start (or `SPYRIA_AGENT_IMAGE` when set), so restart the server after a rebuild; the new image applies to new runtimes. Without a built image, a prompt answers `Spyria's runtime image is not built: run bun run agent:build`.

The build also:

- fails when a package in the image has a license outside the allowlist in `scripts/check-licenses.ts`;
- fills the test-only volume `spyria-test-harnesses` with the pinned harnesses, for the docker tests;
- removes the image it replaces unless a container still uses it, then prunes Docker's build cache down to 10 GB (see [Operations](./operations.md)).

### Build and pair the host

```sh
docker build -t spyria-host apps/host
```

Signed in as a workspace admin (Alice), open the workspace menu > Workspace settings > Connect runtime > Add runtime host, give it a name and copy the command. Run it in the repository root: when the app's origin is `localhost`, the command builds the `spyria-host` image itself, replaces `localhost` with `host.docker.internal` (a container cannot reach the machine's `localhost`) and maps that name to the host gateway. It detects rootless Docker and mounts the right socket, and on macOS it adds group `0` for the Docker socket. The row turns Online within seconds.

With a host online, a prompt in a runtime chat starts that chat's runtime and Pi answers. Runtimes call the model through their host: `spyria-host` relays `/v1/*` (at `http://spyria-gateway-relay:4000/v1` on the runtime's network) to Spyria, which runs each call on the prompting member's key in the gateway.

Each runtime gets its own Docker network (`spyria-rt-<id>-net`), which `spyria-host` joins, so runtimes on one host cannot reach each other where Docker's isolation rules apply (Docker Engine on Linux; OrbStack, for example, accepts traffic between Docker networks).

To run the host as a process instead of a container, against the local Docker:

```sh
SPYRIA_HOST_STATE_DIR=.spyria-host bun apps/host/src/main.ts http://localhost:5173/h/<code>
```

When you are done, remove the host in Workspace settings, then:

```sh
docker rm -f spyria-host
docker volume rm spyria-host
```

### Deployment names

Every Docker object Spyria names comes from `SPYRIA_DEPLOYMENT` (default `spyria`). Another deployment on the same Docker daemon, such as `spyria-prod`, uses the image, container and state volume `spyria-prod-host`, runtimes `spyria-prod-rt-*`, sign-ins `spyria-prod-cred-*` and harnesses `spyria-prod-harnesses`, and its Add host and sign-in commands carry these names. Neither host ever sees the other's runtimes. See [Self-hosting](./self-hosting.md).

### Claude Code and Codex on your own machine

A personal machine (Profile > My machine > Add my machine) runs the same host program with `--personal`. Sign-in, harness install and the workspace policy are described in [Machines](../features/machines.md).

### Host dependencies and lockfiles

The host image installs exactly `apps/host/bun.lock`. After changing a host dependency:

1. run `bun install` at the root;
2. regenerate `apps/host/bun.lock` from a copy of `apps/host/package.json` and the root `bun.lock` in a temporary folder (`bun install --lockfile-only`), keeping the root's versions;
3. run `bun run check:locks`, which fails while the host lock disagrees with its manifest or resolves a package the root lock does not, and while Pi's `package-lock.json` disagrees with its manifest.

## Project layout

| Path | Holds |
|---|---|
| `apps/server` | The Bun and Hono server: auth, HTTP API, Zero mutators, the job worker, the host WebSocket, the model and tool relays. Composition in `apps/server/src/index.ts`. |
| `apps/web` | The React app (Vite). Composition in `apps/web/src/app/factory.ts`. e2e tests in `apps/web/e2e`. |
| `apps/host` | `spyria-host`, the runtime host program. Imports nothing from `@spyria/*`. |
| `apps/agent` | spyria-agent and the runtime image (Pi pinned in `apps/agent/pi`, playwright-core in `apps/agent/browser`). Imports nothing from `@spyria/*`. |
| `packages/conversation` | Chats, messages, the event store, agent turns, sharing, delegation, git actions. |
| `packages/workspace` | Workspaces, projects, chat organization, members and invites, workspace and chat roles. |
| `packages/profile` | A member's profile: LLM keys, tool connections. |
| `packages/runtime` | Runtime hosts, member machines, runtimes and their lifecycle. |
| `packages/panel` | The right panel of a chat: files, changes, commits, browser, usage, members, connected tools. |
| `packages/usage` | Usage metering, spend, budgets and the audit log. |
| `packages/kernel`, `packages/db`, `packages/ui`, `packages/session` | The shared layer: kernel types and logging, the database client and Zero schema, UI components, the signed-in member. |
| `infra/` | The dev stack: `docker-compose.yml`, `dex.yaml`, `bifrost.json`. |
| `deploy/` | The production Compose file `compose.prod.yml`. |
| `scripts/` | Checks and tooling: `check-all.ts`, `check-related.ts`, `check-bundle.ts`, `check-locks.ts`, `check-trust.ts`, `check-licenses.ts`, `agent-image.ts`, `smoke-prod.ts`. |

## Where to start reading

1. [`AGENTS.md`](../../AGENTS.md) at the repository root: the rules every change follows, the layers of a context and the checks before a pull request.
2. [Architecture overview](../architecture/overview.md): the pieces and the life of an agent turn.
3. [Contexts](../architecture/contexts.md): what each package owns and how contexts talk.
4. `apps/server/src/index.ts` and `apps/web/src/app/factory.ts`: where everything is wired together.

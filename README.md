# Spyria

Org-agnostic, model-agnostic AI workspace: agent chats, dev sessions and knowledge.

## Prerequisites

- Bun 1.3
- Node 24 (zero-cache and Vite run on it)
- Docker (Compose project `spyria`: Postgres on 5434, Dex on 5556, zero-cache on 4848, the model gateway on 127.0.0.1:8180; containers `spyria-*`)

## First run

```sh
bun install
bun run db:migrate    # starts Postgres and Dex if needed
bun run db:seed       # skips when the data is already there
bun run dev           # adds zero-cache and the model gateway, then the server on 3000 and the app on http://localhost:5173
```

Migrate and seed before the first `bun run dev`: zero-cache needs the `spyria_zero` publication the migrations create.

## Signing in locally

The app signs in through Dex in a popup (allow popups for `localhost:5173`). The Dex users all have the password `password`:

- `alice@example.com`: member of Acme and Globex
- `bob@example.com`: member of Acme
- `nina@example.com`: no membership (shows the "not invited" screen)

`bun run dev` sets dev values for `SPYRIA_TOKEN_SECRET`, `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID`, `SPYRIA_OIDC_REDIRECT_URI`, `SPYRIA_APP_ORIGIN`, `SPYRIA_GATEWAY_URL`, `SPYRIA_GATEWAY_ADMIN_USER` and `SPYRIA_GATEWAY_ADMIN_PASSWORD`; the server refuses to start without them. Every setting is listed with its dev default in `.env.example`; copy it to `.env.dev` to change one (`bun run dev` and `bun run operator` read it, nothing needs it in dev). Production reads `.env.prod` (both are git-ignored).

`SPYRIA_ENV=production` makes the server check its settings first and refuse to start, listing every problem: `SPYRIA_AUTH_MODE` must be `sso`; `SPYRIA_TOKEN_SECRET` and `SPYRIA_SECRETS_KEY` set, at least 32 characters and not a dev default; `SPYRIA_APP_ORIGIN` on `https://` with `SPYRIA_OIDC_REDIRECT_URI` on it; `SPYRIA_SMTP_URL` and `SPYRIA_MAIL_FROM` set; the gateway URL and admin login set, not the dev defaults. `GET /health` answers 200 `{"status":"ok"}`, or 503 `{"status":"degraded","failing":[…]}` naming `database` and/or `gateway` (2 s per check). On SIGTERM or SIGINT the server stops accepting requests, lets the job worker finish its current jobs, closes the hosts' connections and the database, and exits within 10 s.

## Signing in in production (SSO)

`SPYRIA_AUTH_MODE` is `dex` (default: dev and tests, one global issuer from `SPYRIA_OIDC_ISSUER` and `SPYRIA_OIDC_CLIENT_ID`) or `sso` (production: each workspace signs in through its own OIDC provider). In `sso` mode the server needs `SPYRIA_SECRETS_KEY` (at least 32 characters, for example `openssl rand -hex 32`; it encrypts the providers' client secrets with AES-GCM and can never change without re-entering every secret) and `SPYRIA_OIDC_REDIRECT_URI` (`<server origin>/auth/callback`, registered at every provider). The sign-in screen asks for a work email; its domain routes to the provider of the workspace using that domain.

On a fresh deployment (no workspace yet), the sign-in screen offers "Create a workspace": the organization name, its email domain and the provider (Google Workspace, Microsoft Entra with its tenant id, or another OIDC issuer; the discovery document is checked, the client secret is encrypted and never shown again). Submitting opens the provider's sign-in; the first person who completes it with an address at that domain becomes the Admin of the new workspace. Once a workspace exists, the screen no longer offers it and the server refuses it; "New workspace" in the app reuses the member's verified domain and provider.

A domain routes sign-in, and a workspace can invite, only once its domain is verified. Admins verify a domain in Workspace settings > Sign-in by sending a single-use link (24 h) to any address at it; this needs SMTP: `SPYRIA_SMTP_URL` (for example `smtp://user:pass@smtp.example.com:587`) and `SPYRIA_MAIL_FROM` (for example `Spyria <spyria@example.com>`). Without SMTP, the operator verifies a domain directly: `bun run operator sso:verify-domain --workspace <id> --domain <domain>`.

## Registering the GitHub App (dev chats)

Each deployment registers its own GitHub App. Workspace settings > Connect GitHub shows how, before the form: the steps, the permissions and events, and the homepage, callback and webhook URLs computed from the app's origin, ready to copy. Spyria checks each webhook delivery's `X-Hub-Signature-256` with the webhook secret and ignores a delivery id it already received.

In Workspace settings > GitHub, an admin enters the App id, the client id, the private key, the client secret and the webhook secret (secrets are encrypted with `SPYRIA_SECRETS_KEY`, shown only as set, replaced by entering a new value). The section lists the repositories granted by the App's installations. Members link their own GitHub account in Profile > Connections > My connections: only a chat's owner publishes, with this account (Changes > Push / Open pull request, or the agent's `push_branch` / `open_pull_request` tools on the owner's own prompts), so GitHub shows the owner as the pull request's author.

Publishing runs on the Spyria server, which needs `git` installed: the runtime hands over a git bundle of the working branch and the server pushes it with the owner's token, which never enters the runtime.

A dev runtime chat (New chat > Runtime > Dev) clones the chosen repository into the runtime's workspace volume with a short-lived read-only installation token (never left in the agent's environment or `.git/config`), checks out `spyria/<chat slug>-<id>` from the base branch and runs `.spyria/setup.sh` when present; clone and setup must finish within 2 minutes (the host relay's request limit).

## Adding a runtime host for dev

Runtimes (Spyria's runtime image with spyria-agent) run on runtime hosts: any machine with Docker running the host program (image `spyria-host`, container `spyria-host`), which dials out to Spyria. The names come from the deployment name `SPYRIA_DEPLOYMENT` (default `spyria`): another deployment on the same Docker daemon, such as `spyria-prod`, uses image, container and state volume `spyria-prod-host`, runtimes `spyria-prod-rt-*`, sign-ins `spyria-prod-cred-*` and harnesses `spyria-prod-harnesses`, and its Add host and sign-in commands carry these names, so neither host ever sees the other's runtimes.

```sh
docker build -t spyria-host apps/host
```

The image installs exactly `apps/host/bun.lock`. After changing a host dependency, run `bun install` at the root, then regenerate that lock from a copy of `apps/host/package.json` and the root `bun.lock` (`bun install --lockfile-only` in a temp folder, keeping the root's versions); `bun run check:locks` fails while the two disagree.

Then, signed in as a workspace admin (Alice), open the workspace menu, **Workspace settings**, **Add runtime host**, give it a name and copy the command. On a Mac (OrbStack or Docker Desktop), switch **Rootless Docker** off, and in the copied command replace `localhost` with `host.docker.internal` (the container cannot reach the Mac's `localhost`); the rooted command adds group `0` on macOS by itself. The row turns Online within seconds. Hosts never pull: build Spyria's runtime image first (below).

Without Docker for `spyria-host` itself, run it as a process against the local Docker: `SPYRIA_HOST_STATE_DIR=.spyria-host bun apps/host/src/main.ts http://localhost:5173/h/<code>`. Remove the host in the settings page when done, then `docker rm -f spyria-host` and `docker volume rm spyria-host`.

With a host online, a prompt in a runtime chat starts that chat's runtime and Pi answers. Runtimes call the model through their host: `spyria-host` relays `/v1/*` (at `http://spyria-gateway-relay:4000/v1` on the runtime's network) to Spyria, which runs each call on the prompting member's key in the gateway. Rebuild the `spyria-host` image after pulling this change (`docker build -t spyria-host apps/host`, then recreate the container), or its runtimes cannot reach a model.

Each runtime gets its own Docker network (`spyria-rt-<id>-net`), which `spyria-host` joins, so runtimes on one host cannot reach each other where Docker's isolation rules apply (Docker Engine on Linux; OrbStack accepts traffic between Docker networks). Egress on cloud hosts: Spyria does not filter runtimes' outbound traffic yet; block the metadata endpoint (`169.254.169.254`) and private ranges in the cloud provider's firewall.

## Spyria runtime image

Workspace hosts and personal machines run Spyria's own image (`apps/agent`: spyria-agent with Pi, node/npm, git and ripgrep; Pi is pinned in `apps/agent/pi/package.json` with its `package-lock.json`, installed with `npm ci`). Claude Code, Codex and their ACP adapters are never in the image: they are pinned in `apps/host/src/harnesses.json`, and a member's `spyria-host` installs them on that machine on first use (at `login` or when a session starts, the chat showing "Installing Claude Code…") into the `spyria-harnesses` volume, one folder per pinned set, mounted read-only into the sessions; `SPYRIA_HARNESS_REGISTRY` sets another npm registry. The build fails when a package in the image has a license outside the allowlist of `scripts/check-licenses.ts`, and fills the test-only volume `spyria-test-harnesses` with the pinned harnesses for the docker tests. Build it locally before the first runtime; the server reads its content ID from `apps/agent/image-id` (or `SPYRIA_AGENT_IMAGE`) at start, and no `spyria-host` ever pulls it:

```sh
bun run agent:build          # compile spyria-agent and docker build; cached by Docker
bun run agent:versions       # pinned vs latest on npm, per tool
bun run agent:bump <tool>    # pin the latest of claude-code | claude-agent-acp | codex | codex-acp | pi, then rebuild (for Pi, also regenerates its lockfile)
```

After a rebuild, restart the server: a new content ID applies to new runtimes. Without a built image a prompt says `Spyria's runtime image is not built: run bun run agent:build`.

## Claude Code and Codex on your own machine

A member can run Claude Code on their own Claude subscription, or Codex on their own ChatGPT plan, on their own machine:

1. **Profile**, **My machine**, **Add my machine**: copy the command, which ends with `spyria-host --personal <claim URL>` (on a Mac, switch **Rootless Docker** off and replace `localhost` with `host.docker.internal` as above), and run it on your machine. Never run it on a machine others use: the agent there can read your Claude and ChatGPT sign-ins.
2. Sign in once:
   - Claude Code: `docker exec -it spyria-host spyria-host login claude-code`, open the printed URL, sign in and paste the code. The sign-in stays in the `spyria-cred-claude-code` volume. `docker exec -it spyria-host spyria-host logout claude-code` deletes it.
   - Codex: `docker exec -it spyria-host spyria-host login codex`, open the printed URL and enter the one-time code. ChatGPT may ask you to enable device code sign-in first (ChatGPT settings, **Security**). The sign-in stays in the `spyria-cred-codex` volume (Codex's whole home, shared by your Codex sessions). `docker exec -it spyria-host spyria-host logout codex` deletes it offline; to also revoke the session at OpenAI, log out of all devices in ChatGPT's **Security** settings.
   - Both stay on your machine only; Spyria never sees them.
3. **New chat**, **On my machine · Claude Code subscription** or **On my machine · Codex (ChatGPT plan)**. Only you prompt it (other members read it); it runs on your plan's default model, without Spyria's routing, keys or metering.

Admins turn this off for the workspace with **Workspace settings**, **Runtime hosts**, **Members can run sessions on their own machine**: members can no longer add a machine or start such a chat, and prompts in existing ones get a notice.

Manual checks, not covered by tests (they need a real subscription):

- After `spyria-host login claude-code`, a real turn in an "On my machine" chat answers on the subscription.
- Ask the agent to print `~/.claude/.credentials.json`: the stored step shows `[redacted]`, and `grep sk-ant-` over the chat's events in Postgres finds nothing.
- The session keeps working after the token expires and refreshes, and after its runtime is removed (the sign-in survives in `spyria-cred-claude-code`); VS Code's **Dev Containers: Attach to Running Container** opens the runtime (its server and extensions downloaded on the Mac, since runtimes have no internet).
- `spyria-host login codex` completes with the device code (note whether ChatGPT asked to enable device code sign-in); `auth.json` in `spyria-cred-codex` is `0600` with `auth_mode: "chatgpt"`.
- The refresh token's shape, without printing values: `jq '.tokens | map_values(.[0:6] + "…" + (length|tostring))' auth.json`. `id_token` and `access_token` start with `eyJ`; if `refresh_token` has a stable prefix, add it to the redaction formats in `apps/host/src/personal.ts`.
- A real turn in an "On my machine · Codex" chat answers on the plan's default model (the model shows in the stored events).
- Two Codex sessions started at the same moment both answer, and neither is signed out (the refresh token rotates at every session start).
- Ask the agent to print `~/.codex/auth.json`: the stored step shows `[redacted]`, and `grep eyJ` (and the refresh token's prefix) over the chat's events in Postgres finds nothing.
- Stop a Codex turn mid-command, then send a prompt that refers to the earlier one: the answer uses that context.

## The model gateway

`bun run dev` starts `spyria-gateway` (Bifrost, pinned by digest, config in `infra/bifrost.json`) on `127.0.0.1:8180`. Its first start runs the one-shot `spyria-gateway-database` container, which creates a `bifrost` role and database on `spyria-postgres` (outside Spyria's migrations); its own data lives in the `spyria-gateway-data` volume. Members' API keys are stored in the gateway only: Spyria keeps a reference and the last 4 characters. Dev secrets come from `SPYRIA_GATEWAY_ENCRYPTION_KEY`, `SPYRIA_GATEWAY_SETUP_TOKEN`, `SPYRIA_GATEWAY_ADMIN_USER`, `SPYRIA_GATEWAY_ADMIN_PASSWORD` and `SPYRIA_GATEWAY_DB_PASSWORD` (dev defaults in `infra/docker-compose.yml`); the encryption key can never change without wiping the gateway's database.

Keys added before the gateway existed, including Alice's seeded Anthropic key, are not in it: remove and re-add them in the profile, or prompts are refused. The dev server needs a real provider key (OpenAI, Anthropic, Mistral and the other providers the gateway supports). The fake LLM (`apps/server/src/testing/fake-llm.ts`) is mounted by the test servers only.

## Model routing

The first prompt of a session (and the first prompt after a lost conversation) is classified on the prompter's cheapest reachable model through the gateway (metered with the label `role: router`, 3 s timeout). Only a confident `large` or `small` answer moves away from the prompter's best reachable medium model (else the nearest tier; ties in catalog order); a chat has one model, chosen at its first prompt. Reachable models are the catalog entries (`packages/kernel/src/models.ts`) whose provider has a key of the member in the gateway. The session chip in the chat header shows the session model and opens the popover: switching the main model (applied at the next prompt with `switch_llm`), the subagent policy and the models used in the chat. Router calls are recorded in `model_calls` but left out of the Usage totals.

Manual check, not covered by tests (no real keys in CI): with a real Anthropic key, prompt a new runtime chat and check that `routing_decisions.classifier_output` is filled (Bifrost translating `response_format: json_schema` for Anthropic). If it stays empty, every session runs on the prompter's best reachable medium model.

## Tools through the gateway

Members connect tools (MCP servers) in Profile > Connections > My connections; the agent of a runtime chat then calls them through `spyria-host`'s relay (`/mcp`) and the gateway, always as the chat owner. The OAuth token stays in the gateway against the member's virtual key of that workspace (a member needs an LLM key in the workspace first); Spyria stores only the server name and a status. A server must be set up once per deployment by a Spyria admin before members see it:

1. **GitHub:** create a GitHub OAuth App (Settings > Developer settings > OAuth Apps) with the callback URL `http://localhost:5173/gateway-oauth/api/oauth/callback` (GitHub needs an exact match; use the production origin there), then run `GITHUB_MCP_CLIENT_ID=… GITHUB_MCP_CLIENT_SECRET=… bun run tools:setup github`. Scopes are `repo read:org read:user`. The secret goes to the gateway (encrypted there), never to Spyria's database.
2. **Notion:** nothing to register (the gateway registers itself with Notion's MCP server); run `bun run tools:setup notion`.
3. Each setup prints a login URL: open it, log in once with your own account (the gateway uses it only to discover the server's tools), approve, then press Enter.

The OAuth redirect goes through Spyria's origin: the gateway's `mcp_external_client_url` is `SPYRIA_GATEWAY_OAUTH_BASE` (default `http://localhost:5173/gateway-oauth`, served by Vite's proxy to the server). Changing it means recreating `spyria-gateway` (`docker compose -f infra/docker-compose.yml --profile gateway up -d --force-recreate gateway`) and setting servers up again. After pulling this change, recreate `spyria-gateway` (new config) and rebuild `spyria-host` (it now relays `/mcp`).

Real GitHub and Notion smoke run (needs your login): set both up, connect them in your profile, then in a runtime chat with a real key ask the agent to list your GitHub repositories and to search your Notion workspace; the chat shows "Used <tool> (GitHub)" and "Used <tool> (Notion)" steps. Disconnect revokes the gateway's token only: remove the grant at the provider (GitHub settings > Applications, Notion > Connections) to revoke it upstream.

## Day to day

```sh
bun run dev           # stack, server and app
bun run db:migrate    # after pulling new migrations (2.3.1: then restart zero-cache, the chats publication changed)
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
bun run test:integration   # needs bun run stack:up; runs its own gateway (spyria-test-gateway-integration on 4880) and the test Dex (spyria-test-dex on 5557)
bun run check:boundaries
bun run lint
bun run check:bundle       # builds the app, main chunk at most 760 kB, one React, no server-only SQL
bun run test:e2e           # starts its own stack per worker, one gateway (spyria-test-gateway-e2e on 4881), one test Dex for both stacks (spyria-test-dex on 5557, `apps/web/e2e/dex-test.yaml`, shared with integration, never the dev Dex) and an sso-mode stack (server 3102, app 5191); e2e/00-platform runs first and gates the rest
bun run test:e2e:smoke     # the @smoke critical paths only (29 tests, every segment), after the 00-platform gate
bun run test:e2e -- e2e/04-agent   # one segment (00-platform still runs first)
bun run test:ui            # the visual suite apps/web/ui: screenshots light and dark against the baselines, keyboard and resize checks; not in check:all
bun run test:ui:update     # regenerate the screenshot baselines after an intended design change, then review the changed PNGs
```

`check:related [--base <ref>]` takes the uncommitted changes plus the commits since `<ref>` (default `HEAD`). It runs the unit and integration test files that changed or import a changed module, directly or not (dependency-cruiser's graph), and Playwright `--only-changed=<ref>` when a spec imports a changed module. It prints what it selected and why. It runs a whole suite when it cannot decide: a changed file outside the module graph (lock file, config, SQL, infra) runs every suite, `integration-setup.ts` runs every integration test, and an e2e harness file (`test-server.ts`, `testing.ts`, the fake LLM, `global-setup.ts`, `playwright.config.ts`) runs the whole e2e suite. App code that e2e reaches only through the servers is left to `check:all`.

`check:all` writes its full output to `.check/last-check-all.log` and a summary to `.check/last-check-all.json`: the `git stash create` fingerprint (HEAD when the tree is clean), HEAD, the tree hash of the working tree including untracked files, the exit code, and each step's result and duration. `--verify` compares that tree hash with the current tree.

e2e is organized in segments under `apps/web/e2e` (`00-platform` … `08-admin`), one file per area, one `describe` per area and titles as user stories ("As <role>, I …") with spec tags (`@spec-NN`), `@smoke` and `@slow`. The `platform` Playwright project (`00-platform`: standalone reset check, a browser mutation confirmed by the server, an agent stream frame of a scripted turn, a gateway call recorded with its prompter and owner) is a dependency of the `e2e` project: when it fails, nothing else runs and `e2e/platform-gate.ts` prints that the stack, not a feature, is broken. In `04-agent`, questions, plan mode, Stop, steps and streaming run once per harness (`[Pi]` on a Spyria runtime, `[Claude Code]` and `[Codex]` on the fake machine) through `forEachHarness`. The `ui` project (`apps/web/ui`) holds the looks: `toHaveScreenshot` in light and dark on fixed states (baselines in `apps/web/ui/*-snapshots/`, platform-specific), plus keyboard, resize and colour assertions.

e2e tests run on one fake runtime host per worker database: the test server relays its runtimes to a real spyria-agent process driving `stub-acp-agent.mjs` (Pi flavour), which runs each chat's fake LLM script through the real relay and gateway, running commands with `bash` and editing files in a temporary directory. A fake runtime answers `/ready` 200 ms after its start (`fakeBootMilliseconds` changes it per test, 1.5 s keeps Starting… visible). `agentScript` replaces a chat's fake LLM script only once a model call has used the previous one (the test server refuses with 409 after 30 s), so a test can switch to a fast script while a slow turn is starting. Failed tests keep a screenshot and `error-context.md` in `apps/web/test-results`; traces are off because recording one per test made the suite about 25% slower, so add `--trace retain-on-failure` when chasing a failure. Real containers run only in `bun run check:docker` (integration: `sandbox`, `personal-host`, `harness-install` with stub packages from a local fake npm registry, `machine-session` and `pi`).

Tools in tests: the test server runs the fake OAuth-protected MCP server on 3101 (3101 must be free) and registers it in the test gateway as `fake`, `GitHub`, `Slack`, `Notion` and `Linear`, completing each admin login automatically; a test picks the account the fake provider approves with the `fake_mcp_user` cookie, and `POST /_admin/expire?user=` revokes that account's tokens. The integration harness does the same with `fake` on a random port.

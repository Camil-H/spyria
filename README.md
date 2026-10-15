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

Runtimes (HQ's runtime image with hq-agent) run on runtime hosts: any machine with Docker running the `hq-host` container, which dials out to HQ.

```sh
docker build -t hq-host apps/host
```

Then, signed in as a workspace admin (Alice), open the workspace menu, **Workspace settings**, **Add runtime host**, give it a name and copy the command. On a Mac (OrbStack or Docker Desktop), switch **Rootless Docker** off, and in the copied command replace `localhost` with `host.docker.internal` (the container cannot reach the Mac's `localhost`); the rooted command adds group `0` on macOS by itself. The row turns Online within seconds. Hosts never pull: build HQ's runtime image first (below).

Without Docker for `hq-host` itself, run it as a process against the local Docker: `HQ_HOST_STATE_DIR=.hq-host bun apps/host/src/main.ts http://localhost:5173/h/<code>`. Remove the host in the settings page when done, then `docker rm -f hq-host` and `docker volume rm hq-host`.

With a host online, a prompt in a runtime chat starts that chat's runtime and Pi answers. Runtimes call the model through their host: `hq-host` relays `/v1/*` (at `http://hq-gateway-relay:4000/v1` on the runtime's network) to HQ, which runs each call on the prompting member's key in the gateway. Rebuild the `hq-host` image after pulling this change (`docker build -t hq-host apps/host`, then recreate the container), or its runtimes cannot reach a model.

Each runtime gets its own Docker network (`hq-rt-<id>-net`), which `hq-host` joins, so runtimes on one host cannot reach each other where Docker's isolation rules apply (Docker Engine on Linux; OrbStack accepts traffic between Docker networks). Egress on cloud hosts: HQ does not filter runtimes' outbound traffic yet; block the metadata endpoint (`169.254.169.254`) and private ranges in the cloud provider's firewall.

## HQ runtime image

Workspace hosts and personal machines run HQ's own image (`apps/agent`: hq-agent with Claude Code, Codex and Pi, each pinned separately from its ACP adapter in `apps/agent/versions.json`). Build it locally before the first runtime; the server reads its content ID from `apps/agent/image-id` (or `HQ_AGENT_IMAGE`) at start, and no `hq-host` ever pulls it:

```sh
bun run agent:build          # compile hq-agent and docker build; cached by Docker
bun run agent:versions       # pinned vs latest on npm, per tool
bun run agent:bump <tool>    # pin the latest of claude-code | claude-agent-acp | codex | codex-acp | pi, then rebuild
```

After a rebuild, restart the server: a new content ID applies to new runtimes. Without a built image a prompt says `HQ's runtime image is not built: run bun run agent:build`.

## Claude Code and Codex on your own machine

A member can run Claude Code on their own Claude subscription, or Codex on their own ChatGPT plan, on their own machine:

1. **Profile**, **My machine**, **Add my machine**: copy the command, which ends with `hq-host --personal <claim URL>` (on a Mac, switch **Rootless Docker** off and replace `localhost` with `host.docker.internal` as above), and run it on your machine. Never run it on a machine others use: the agent there can read your Claude and ChatGPT sign-ins.
2. Sign in once:
   - Claude Code: `docker exec -it hq-host hq-host login claude`, open the printed URL, sign in and paste the code. The sign-in stays in the `hq-cred-claude` volume. `docker exec -it hq-host hq-host logout claude` deletes it.
   - Codex: `docker exec -it hq-host hq-host login codex`, open the printed URL and enter the one-time code. ChatGPT may ask you to enable device code sign-in first (ChatGPT settings, **Security**). The sign-in stays in the `hq-cred-codex` volume (Codex's whole home, shared by your Codex sessions). `docker exec -it hq-host hq-host logout codex` deletes it offline; to also revoke the session at OpenAI, log out of all devices in ChatGPT's **Security** settings.
   - Both stay on your machine only; HQ never sees them.
3. **New chat**, **On my machine · Claude Code subscription** or **On my machine · Codex (ChatGPT plan)**. Only you prompt it (other members read it); it runs on your plan's default model, without HQ's routing, keys or metering.

Admins turn this off for the workspace with **Workspace settings**, **Runtime hosts**, **Members can run sessions on their own machine**: members can no longer add a machine or start such a chat, and prompts in existing ones get a notice.

Manual checks, not covered by tests (they need a real subscription):

- After `hq-host login claude`, a real turn in an "On my machine" chat answers on the subscription.
- Ask the agent to print `~/.claude/.credentials.json`: the stored step shows `[redacted]`, and `grep sk-ant-` over the chat's events in Postgres finds nothing.
- The session keeps working after the token expires and refreshes, and after its runtime is removed (the sign-in survives in `hq-cred-claude`); VS Code's **Dev Containers: Attach to Running Container** opens the runtime (its server and extensions downloaded on the Mac, since runtimes have no internet).
- `hq-host login codex` completes with the device code (note whether ChatGPT asked to enable device code sign-in); `auth.json` in `hq-cred-codex` is `0600` with `auth_mode: "chatgpt"`.
- The refresh token's shape, without printing values: `jq '.tokens | map_values(.[0:6] + "…" + (length|tostring))' auth.json`. `id_token` and `access_token` start with `eyJ`; if `refresh_token` has a stable prefix, add it to the redaction formats in `apps/host/src/personal.ts`.
- A real turn in an "On my machine · Codex" chat answers on the plan's default model (the model shows in the stored events).
- Two Codex sessions started at the same moment both answer, and neither is signed out (the refresh token rotates at every session start).
- Ask the agent to print `~/.codex/auth.json`: the stored step shows `[redacted]`, and `grep eyJ` (and the refresh token's prefix) over the chat's events in Postgres finds nothing.
- Stop a Codex turn mid-command, then send a prompt that refers to the earlier one: the answer uses that context.

## The model gateway

`bun run dev` starts `hq-gateway` (Bifrost, pinned by digest, config in `infra/bifrost.json`) on `127.0.0.1:8180`. Its first start runs the one-shot `hq-gateway-database` container, which creates a `bifrost` role and database on `hq-postgres` (outside HQ's migrations); its own data lives in the `hq-gateway-data` volume. Members' API keys are stored in the gateway only: HQ keeps a reference and the last 4 characters. Dev secrets come from `HQ_GATEWAY_ENCRYPTION_KEY`, `HQ_GATEWAY_SETUP_TOKEN`, `HQ_GATEWAY_ADMIN_USER`, `HQ_GATEWAY_ADMIN_PASSWORD` and `HQ_GATEWAY_DB_PASSWORD` (dev defaults in `infra/docker-compose.yml`); the encryption key can never change without wiping the gateway's database.

Keys added before the gateway existed, including Alice's seeded Anthropic key, are not in it: remove and re-add them in the profile, or prompts are refused. Supported providers are OpenAI, Anthropic, Mistral and Fake. Without real keys, add a key with provider `Fake` (or `Fake-small`, which reaches only `fake-small`) and any secret (a secret containing `refused` is refused, to try the error path): the dev server registers its fake LLM (`/fake-llm`) as the gateway's `fake` and `fake-small` providers. Setting `HQ_LLM_MODEL` (for example `openai/anthropic/claude-sonnet-4-5` with an Anthropic key) runs every conversation on that model with routing off, and the fake LLM is not mounted.

## Model routing

The first prompt of a session (and the first prompt after a lost conversation) is classified on the prompter's cheapest reachable model through the gateway (metered with the label `role: router`, 3 s timeout). Only a confident `large` or `small` answer moves away from the chat's default model, which is set at creation to the creator's strongest reachable medium model. Reachable models are the catalog entries (`packages/kernel/src/models.ts`) whose provider has a key of the member in the gateway. The session chip in the chat header shows the session model and opens the popover: switching the main model (applied at the next prompt with `switch_llm`), the default model, the subagent policy and the models used in the chat. Router calls are recorded in `model_calls` but left out of the Usage totals.

Manual check, not covered by tests (no real keys in CI): with a real Anthropic key, prompt a new runtime chat and check that `routing_decisions.classifier_output` is filled (Bifrost translating `response_format: json_schema` for Anthropic). If it stays empty, every session runs on the chat default model.

## Tools through the gateway

Members connect tools (MCP servers) in Profile > Connections > My connections; the agent of a runtime chat then calls them through `hq-host`'s relay (`/mcp`) and the gateway, always as the chat owner. The OAuth token stays in the gateway against the member's virtual key of that workspace (a member needs an LLM key in the workspace first); HQ stores only the server name and a status. A server must be set up once per deployment by an HQ admin before members see it:

1. **GitHub:** create a GitHub OAuth App (Settings > Developer settings > OAuth Apps) with the callback URL `http://localhost:5173/gateway-oauth/api/oauth/callback` (GitHub needs an exact match; use the production origin there), then run `GITHUB_MCP_CLIENT_ID=… GITHUB_MCP_CLIENT_SECRET=… bun run tools:setup github`. Scopes are `repo read:org read:user`. The secret goes to the gateway (encrypted there), never to HQ's database.
2. **Notion:** nothing to register (the gateway registers itself with Notion's MCP server); run `bun run tools:setup notion`.
3. Each setup prints a login URL: open it, log in once with your own account (the gateway uses it only to discover the server's tools), approve, then press Enter.

The OAuth redirect goes through HQ's origin: the gateway's `mcp_external_client_url` is `HQ_GATEWAY_OAUTH_BASE` (default `http://localhost:5173/gateway-oauth`, served by Vite's proxy to the server). Changing it means recreating `hq-gateway` (`docker compose -f infra/docker-compose.yml --profile gateway up -d --force-recreate gateway`) and setting servers up again. After pulling this change, recreate `hq-gateway` (new config) and rebuild `hq-host` (it now relays `/mcp`).

Without real accounts, run the fake OAuth-protected MCP server (`bun apps/server/src/fake-mcp.ts`, port 3001, approves any login as `fake-admin` or as the `fake_mcp_user` cookie) and `bun run tools:setup fake`. Real GitHub and Notion smoke run (needs your login): set both up, connect them in your profile, then in a runtime chat with a real model (`HQ_LLM_MODEL`) ask the agent to list your GitHub repositories and to search your Notion workspace; the chat shows "Used <tool> (GitHub)" and "Used <tool> (Notion)" steps. Disconnect revokes the gateway's token only: remove the grant at the provider (GitHub settings > Applications, Notion > Connections) to revoke it upstream.

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
bun run test:integration   # needs bun run stack:up; runs its own gateway (hq-test-gateway-integration on 4880)
bun run check:boundaries
bun run lint
bun run check:bundle       # builds the app, main chunk at most 760 kB, one React, no server-only SQL
bun run test:e2e           # starts its own stack per worker and one gateway (hq-test-gateway-e2e on 4881)
```

`check:related [--base <ref>]` takes the uncommitted changes plus the commits since `<ref>` (default `HEAD`). It runs the unit and integration test files that changed or import a changed module, directly or not (dependency-cruiser's graph), and Playwright `--only-changed=<ref>` when a spec imports a changed module. It prints what it selected and why. It runs a whole suite when it cannot decide: a changed file outside the module graph (lock file, config, SQL, infra) runs every suite, `integration-setup.ts` runs every integration test, and an e2e harness file (`test-server.ts`, `testing.ts`, the fake LLM, `global-setup.ts`, `playwright.config.ts`) runs the whole e2e suite. App code that e2e reaches only through the servers is left to `check:all`.

`check:all` writes its full output to `.check/last-check-all.log` and a summary to `.check/last-check-all.json`: the `git stash create` fingerprint (HEAD when the tree is clean), HEAD, the tree hash of the working tree including untracked files, the exit code, and each step's result and duration. `--verify` compares that tree hash with the current tree.

e2e tests run on one fake runtime host per worker database: the test server relays its runtimes to a real hq-agent process driving `stub-acp-agent.mjs` (Pi flavour), which runs each chat's fake LLM script through the real relay and gateway, running commands with `bash` and editing files in a temporary directory. A fake runtime answers `/ready` 200 ms after its start (`fakeBootMilliseconds` changes it per test, 1.5 s keeps Starting… visible). `agentScript` replaces a chat's fake LLM script only once a model call has used the previous one (the test server refuses with 409 after 30 s), so a test can switch to a fast script while a slow turn is starting. Failed tests keep a screenshot and `error-context.md` in `apps/web/test-results`; traces are off because recording one per test made the suite about 25% slower, so add `--trace retain-on-failure` when chasing a failure. Real containers run only in `bun run check:docker` (integration: `sandbox`, `personal-host`, `pi`).

Tools in tests: the test server runs the fake OAuth-protected MCP server on 3101 (3101 must be free) and registers it in the test gateway as `fake`, `GitHub`, `Slack`, `Notion` and `Linear`, completing each admin login automatically; a test picks the account the fake provider approves with the `fake_mcp_user` cookie, and `POST /_admin/expire?user=` revokes that account's tokens. The integration harness does the same with `fake` on a random port.

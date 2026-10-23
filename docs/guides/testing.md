# Testing

Spyria's tests are layered: each behaviour is proved once, at the lowest layer that can prove it. This guide explains the layers and when to use each, the commands, the fakes that replace every outside service, the e2e conventions and how to chase a failure. The rules themselves are summarized in [`AGENTS.md`](../../AGENTS.md); the dev stack is described in [Development](./development.md).

## The layers

| Layer | Files | Proves | Runs on |
|---|---|---|---|
| Unit | `*.test.ts` next to the file | Pure logic with many cases: `domain/`, parsers, formatters. | `bun test`, no container. |
| Integration | `*.integration.test.ts` (mostly `apps/server/src`) | Server contracts, permission refusals, security invariants, data correctness, external contracts against fakes. | Its own test Postgres, gateway and Dex. |
| e2e | `apps/web/e2e/<segment>/<area>.spec.ts` | One user story per test: the happy path and the refusal a user sees. | Playwright against a full test stack per worker. |
| Visual | `apps/web/ui/*.spec.ts` | The looks: screenshots in light and dark, keyboard, resize and colour checks. | Playwright, same stack. |
| Docker | `*.docker.test.ts` | The host program and runtimes in real containers. | Docker, with the built runtime image. |

Pick the lowest layer that proves the behaviour, and do not repeat a check another layer already covers. A permission refusal, for example, is proved by an integration test; the e2e test shows only what the user sees when refused. Never weaken an assertion to make a test pass.

## Commands

```sh
bun run check:related      # while iterating: lint, typecheck, boundaries, then only the affected tests
bun run check:all          # everything below in order, failing fast; never touches the dev stack
bun run check:all --verify # does the last check:all match the current tree, and did it pass?
bun run typecheck
bun run lint               # biome; `bunx biome check --write .` fixes formatting and import order
bun run check:boundaries   # dependency-cruiser layer and context rules
bun run check:locks        # the host and Pi lockfiles agree with their manifests and the root lock
bun run test               # unit tests
bun run test:integration   # integration tests
bun run check:bundle       # builds the web app and checks its main chunk
bun run test:e2e           # the e2e suite
bun run test:e2e:smoke     # only the tests tagged @smoke, after the platform gate
bun run test:e2e -- e2e/04-agent   # one segment (the platform gate still runs first)
bun run test:ui            # the visual suite; not in check:all
bun run test:ui:update     # regenerate the screenshot baselines after an intended design change
bun run check:docker       # agent:build, check:trust, then the docker tests
bun run check:trust        # the built runtime and host images hold no distrusted root
bun run smoke:prod         # the production Compose file under a throwaway name; not in check:all
```

`check:all` runs, in order: `lint`, `typecheck`, `check:boundaries`, `check:locks`, `test`, `check:bundle`, `test:integration`, `test:e2e`. `check:docker` runs `agent:build`, `check:trust` and `test:docker:integration`. Both stop at the first failing step and end with the 20 slowest tests of each suite.

`check:bundle` builds the app and fails when the main chunk is over 250,000 bytes, when it contains code that belongs in a lazy chunk, when it holds more than one React version, or when any client asset contains server-only SQL (for example `into events` or `skip locked`).

`smoke:prod` is described in [Self-hosting](./self-hosting.md).

### Before a pull request

Run `typecheck`, `lint`, `check:boundaries` and `check:related`. Run `check:all` for changes to shared code (`packages/kernel`, `packages/db`, test helpers), and `check:docker` for the host, the agent or the images.

### How `check:related` chooses

`check:related [--base <ref>]` takes the uncommitted changes, untracked files included, plus the commits since `<ref>` (default `HEAD`). It runs lint, typecheck and boundaries in parallel, builds dependency-cruiser's module graph, then selects:

- the unit and integration test files that changed, or that import a changed module directly or not;
- Playwright with `--only-changed=<ref>` when an e2e spec imports a changed module.

It prints what it selected and why. It runs a whole suite when it cannot decide:

- a changed file outside the module graph (a lock file, SQL, infra) runs every suite;
- `apps/server/src/testing/integration-setup.ts` runs every integration test;
- an e2e harness file (the test servers, `testing.ts`, the fake LLM, `playwright.config.ts`, `global-setup.ts`, `stack-ports.ts`, `platform-gate.ts`) runs the whole e2e suite.

Markdown, `scripts/`, `biome.json`, `.dependency-cruiser.cjs` and web assets select no test. App code that e2e reaches only through the servers is left to `check:all`.

### What `check:all` records

`check:all` writes its full output to `.check/last-check-all.log` and a summary to `.check/last-check-all.json`: the `git stash create` fingerprint (HEAD when the tree is clean), HEAD, the tree hash of the working tree including untracked files, the exit code, and each step's result and duration. `--verify` compares that tree hash with the current tree and exits non-zero when they differ or the run failed, so you can tell whether a green run still applies.

## Test infrastructure

Tests start and own their containers; they never touch the dev stack.

| Piece | Container or port | Notes |
|---|---|---|
| Test Postgres | `spyria-test-postgres` on 5435 | In memory (tmpfs, 4 GB at most), WAL capped at 1 GB; recreated when its settings change. Integration tests create their own databases (`spyria_test_<id>`), cloned from a migrated template. |
| Test Dex | `spyria-test-dex` on 5557 | Config `apps/web/e2e/dex-test.yaml`, shared by integration and e2e, never the dev Dex. |
| Integration gateway | `spyria-test-gateway-integration` on 4880 | A Bifrost of its own, on its own database. |
| e2e gateway | `spyria-test-gateway-e2e` on 4881 | One for the whole e2e run. |
| e2e test server and app | server 3100, app 5190 | One database per worker (`spyria_e2e_w<n>`), zero-cache per worker from port 4900. |
| SSO-mode stack | server 3102, app 5191 | For sign-in tests in `sso` mode. |
| Fake MCP server | 3101 | Must be free when e2e starts. |

Playwright runs 3 workers by default; `WORKERS=<n>` changes it (8 at most).

### Cleanup

Each run starts by removing what killed runs left behind: idle `spyria_test_<id>` and `spyria_e2e_w<n>` databases and inactive test replication slots in the test Postgres, and `spyria-test-<id>-*`, `spyria-test-e2e-*` and `spyria-test-certs-<id>` containers, volumes and networks older than 30 minutes. The reused fixtures stay: `spyria-test-postgres`, `spyria-test-dex`, the `spyria-test-gateway-*` containers and the `spyria-test-harnesses` volume.

## The fakes

No test calls a real LLM, identity provider, GitHub or npm. The fakes live in `apps/server/src/testing/`:

| File | Replaces |
|---|---|
| `fake-llm.ts` | Model providers. Each chat follows a script of model answers (text, tool calls, delays), served through the real relay and gateway. |
| `fake-mcp.ts` | An OAuth-protected MCP server, plus a shared tool server (`crm`) authenticated by a header secret. |
| `fake-github.ts` | GitHub's API, App installations and repositories; it enforces the token permissions GitHub would. |
| `fake-smtp.ts` | The SMTP server: captures mail so a test can follow the verification link. |
| `harnesses.ts` | The npm registry (`startFakeNpmRegistry`) with stub harness packages, and the `spyria-test-harnesses` volume. |
| `spyria-agent-relay.ts` | A runtime host: fake runtimes driving a real spyria-agent process. |
| `telemetry.ts` | An OTLP collector, to check what the server exports. |
| `test-server.ts`, `sso-test-server.ts` | The e2e servers, with `/test/*` control endpoints. |
| `testing.ts` | Shared helpers, among them `rejectionOf(promise)`. |

In `bun test`, await a promise before asserting on its rejection with `rejectionOf(promise)` rather than `expect(promise).rejects`.

### Tools in tests

The e2e test server runs the fake MCP server on 3101 and registers it in the test gateway as `fake`, `GitHub`, `Slack`, `Notion` and `Linear`, completing each admin login automatically. A test picks the account the fake provider approves with the `fake_mcp_user` cookie, and `POST /_admin/expire?user=<user>` on the fake revokes that account's tokens. The integration harness does the same with `fake` on a random port.

### Runtimes in e2e

e2e tests run on one fake runtime host per worker database. The test server relays its runtimes to a real spyria-agent process driving `apps/agent/fixtures/stub-acp-agent.mjs` (Pi flavour), which runs each chat's fake LLM script through the real relay and gateway, running commands with `bash` and editing files in a temporary directory.

Timing is controlled by named holds, not sleeps:

- `fakeBootHold` keeps a fake runtime booting until the test releases it, so a "Starting…" state stays visible;
- `release(name)`, `reached(name)` and `heldCommand(name)` let a test hold a command or a step and release it when it is ready to assert;
- `agentScript(chatId, script)` replaces a chat's fake LLM script once a model call has used the previous one (the test server answers 409 after 30 seconds otherwise), so a test can switch to a fast script while a slow turn is starting.

## e2e conventions

The suite lives in `apps/web/e2e`, in segments that run in this order of dependency:

| Segment | Covers |
|---|---|
| `00-platform` | The gate: the stack itself works. |
| `01-access` | Sign-in, sessions, SSO, workspaces, the team, roles. |
| `02-chats` | Channels, messaging, threads, unread, organizing chats. |
| `03-sharing` | Chat members, chat permissions, fork, runtime from a thread. |
| `04-agent` | Conversation, steps, questions, delegation, models, errors, runtime lifecycle. |
| `05-machines` | Workspace hosts, a member's machine, harness install, machine sessions, the policy, where a chat runs. |
| `06-connectors` | LLM keys, personal and shared tools, guest rights, the GitHub account. |
| `07-dev-mode` | GitHub setup, dev chats, the workspace panel, branch actions, pull requests. |
| `08-admin` | Audit log, spend, budgets. |

Rules:

- One file per area, one `describe` per area, shared helpers in the segment's `fixtures.ts`.
- Every title is a user story: "As <role>, I …", for example "As a member, I create a project in the browser and the server stores it".
- Tags: spec tags of the form `@spec-<n>` group the tests of one feature, so `--grep @spec-<n>` runs them together; `@smoke` marks the critical path of each segment (`bun run test:e2e:smoke`); `@slow` marks tests that need long waits.
- In `04-agent`, questions, Stop, steps and streaming run once per harness (`[Pi]` on a Spyria runtime, `[Claude Code]` and `[Codex]` on the fake machine) through `forEachHarness` in `04-agent/fixtures.ts`.

### The platform gate

`00-platform` is the Playwright project `platform`, a dependency of the `e2e` project. It checks the stack, not a feature: a reset leaves only the seed, a project inserted through SQL shows up live, a browser mutation is stored by the server, an agent stream frame of a scripted turn arrives, and a model call through the gateway is recorded with its prompter and owner. When it fails, nothing else runs, and `e2e/platform-gate.ts` prints that the test stack is broken rather than a feature.

## The visual suite

The `ui` project (`apps/web/ui`) holds the looks: `toHaveScreenshot` in light and dark on fixed states, plus keyboard, resize and colour assertions. Baselines are in `apps/web/ui/*-snapshots/` and are platform-specific. Run it with `bun run test:ui`; after an intended design change, run `bun run test:ui:update` and review every changed PNG before committing. Never update baselines to make an unintended difference pass.

## Docker tests

`bun run check:docker` builds the runtime image, checks its CA roots, then runs the docker tests with real containers:

| File | Proves |
|---|---|
| `apps/server/src/runtime-hosts/sandbox.docker.test.ts` | Runtime containers and their isolation. |
| `apps/server/src/runtime-hosts/personal-host.docker.test.ts` | A member's personal host. |
| `apps/server/src/runtime-hosts/harness-install.docker.test.ts` | Harness install from a registry (the fake npm registry with stub packages) into the volume, mounted read-only. |
| `apps/server/src/agent-bridge/machine-session.docker.test.ts` | A session on a member's machine. |
| `apps/server/src/agent-bridge/pi.docker.test.ts` | Pi in the real runtime image. |

## Chasing a failure

- A failed Playwright test keeps a screenshot and `error-context.md` in `apps/web/test-results`.
- Traces are off by default, because recording one per test makes the suite noticeably slower. Add one when chasing a failure: `bun run test:e2e -- e2e/04-agent --trace retain-on-failure`.
- Run one segment or one file to iterate quickly; the platform gate still runs first.
- If only the platform gate fails, look at the stack (database, zero-cache, gateway, ports) before any feature.
- Read `.check/last-check-all.log` for the full output of the last `check:all`.

## Manual checks

Some behaviour needs real accounts and cannot run in CI. Run these by hand when you change the related code.

### Model routing with a real key

With a real Anthropic key, prompt a new runtime chat and check that `routing_decisions.classifier_output` is filled (the gateway translating `response_format: json_schema` for Anthropic). If it stays empty, every session runs on the prompter's best reachable medium model.

### Real GitHub and Notion tools

Set both tool servers up (see [Development](./development.md#tools-mcp-servers-in-development)), connect them in your profile, then in a runtime chat with a real key ask the agent to list your GitHub repositories and to search your Notion workspace. The chat shows "Used <tool> (GitHub)" and "Used <tool> (Notion)" steps.

### Claude Code on a subscription

- After `spyria-host login claude-code`, a real turn in a runtime chat that runs on **Local · Claude Code** answers on the subscription.
- Ask the agent to print `~/.claude/.credentials.json`: the stored step shows `[redacted]`, and searching the chat's events in Postgres for `sk-ant-` finds nothing.
- The session keeps working after the token expires and refreshes, and after its runtime is removed (the sign-in survives in the `<deployment>-cred-claude-code` volume).
- VS Code's "Dev Containers: Attach to Running Container" opens the runtime.

### Codex on a ChatGPT plan

- `spyria-host login codex` completes with the device code (note whether ChatGPT asked to enable device code sign-in); `auth.json` in the `<deployment>-cred-codex` volume is `0600` with `auth_mode: "chatgpt"`.
- Check the refresh token's shape without printing values: `jq '.tokens | map_values(.[0:6] + "…" + (length|tostring))' auth.json`. `id_token` and `access_token` start with `eyJ`; if `refresh_token` has a stable prefix, add it to the redaction formats in `apps/host/src/personal.ts`.
- A real turn in a runtime chat that runs on **Local · Codex** answers on the plan's default model (the model shows in the stored events).
- Two Codex sessions started at the same moment both answer, and neither is signed out (the refresh token rotates at every session start).
- Ask the agent to print `~/.codex/auth.json`: the stored step shows `[redacted]`, and searching the chat's events in Postgres for `eyJ` (and the refresh token's prefix) finds nothing.
- Stop a Codex turn mid-command, then send a prompt that refers to the earlier one: the answer uses that context.

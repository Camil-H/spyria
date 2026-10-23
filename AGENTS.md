# AGENTS.md

Instructions for anyone changing this repository: coding agents and people. Read it before your first change.

## What Spyria is

An organization-agnostic, model-agnostic AI workspace: chats and channels where members and agents work together, agent runs in sandboxed runtimes (Pi on Spyria runtimes, Claude Code and Codex on a member's own machine), dev chats on GitHub repositories with pull requests, and the admin side (members, roles, SSO, budgets, audit). Self-hosted with one Docker Compose file (see [docs/guides/self-hosting.md](docs/guides/self-hosting.md)). The documentation index is [docs/README.md](docs/README.md).

Stack: Bun 1.4 + Hono server, React 19 with the React Compiler, TypeScript 7, Vite 8, Rocicorp Zero for UI state sync, Postgres 18 with Drizzle (pinned), Bifrost as the model gateway, OpenTelemetry. A Bun workspace: `apps/` (server, web, host, agent) and `packages/` (one per bounded context, plus `kernel`, `db`, `ui`, `session`).

## Non-negotiable rules

- **Auth is enforced on the server**, never only in the UI. Every table carries `workspace_id`; every read and write is scoped to the caller's workspace and checked against their permissions.
- **Postgres is the source of truth**: data model, append-only event store, job queue. No extra broker. Migrations are Drizzle migrations; never edit one that has shipped.
- **Real-time:** UI state syncs through Zero; agent tokens stream over WebSocket/SSE and never through Zero; only completed events are written to Postgres.
- **Credentials:** model calls use the prompting member's own key through the gateway and record prompter and owner. A member's subscription tokens (Claude, ChatGPT) never reach the server. GitHub tokens never enter a runtime (the server pushes from bundles).
- **Never log or return secrets:** tokens, keys, cookies, request bodies, prompts or model output stay out of logs, errors and URLs.
- **Optimize for smoothness first, minimum code second.** Prefer deleting code to adding abstractions.
- **No comments: code explains itself.** Use explicit names for variables, functions and files, small functions and typed errors instead of comments. A comment is acceptable only for what the code cannot say (a non-obvious external constraint, such as a vendor bug with its issue link); never to narrate what the code does.

## Where code goes

Each package under `packages/` is a bounded context with the same layout, so knowing one means knowing them all:

| Directory | Holds | May import |
|---|---|---|
| `domain/` | entities, value objects, invariants, pure functions | `kernel` only, no third-party dependency |
| `contracts/` | interfaces the inner layers need (repositories, gateways) | `domain`, `kernel` |
| `operations/` | one operation per unit of work, file named by verb, runs inside its own transaction | `domain`, `contracts`, `kernel` |
| `queries/` | read models for the outside world, may lag the write model | `domain`, `kernel`, `db` |
| `integrations/` | outbound adapters implementing contracts (Postgres, Zero, HTTP, gateway) | `domain`, `contracts`, `kernel`, libraries, another context's published entry |
| `entrypoints/` | inbound: routes, mutators, jobs, React components and hooks; boundary validation | `domain`, `contracts`, `operations`, `queries`; only `mutators.ts`, `jobs.ts` and `endpoints.ts` wire `integrations` |

`operations/`, `queries/` and `integrations/` never import each other. A context reaches another only from its `integrations/`, through that context's published entry; apps reach a context only through its `client.ts` (web) or `server.ts` (server) entry. Contracts are owned by the code that consumes them. Composition happens in one place per app (`apps/server/src/index.ts`, `apps/web/src/app/factory.ts`). `apps/host` and `apps/agent` import nothing from `@spyria/*`. `bun run check:boundaries` enforces these rules (`.dependency-cruiser.cjs`); a failure there is a design problem, not a lint nit.

Errors are typed (`DomainError` subclasses with a code) and travel unchanged to the layer that decides the outcome. Server logs go through the kernel `log` / the app's telemetry module: one JSON line per event with `event.name`, never `console.*` in daemon code.

## Tests

Pick the lowest layer that proves the behaviour, and do not duplicate a check that a layer already covers:

- **Unit** (`*.test.ts` next to the file): pure logic with many cases (`domain/`, parsers, formatters).
- **Integration** (`*.integration.test.ts`, `apps/server/src`): server contracts, permission refusals, security invariants, data correctness, external contracts against fakes. Runs on its own test Postgres and gateway.
- **e2e** (`apps/web/e2e/<segment>/<area>.spec.ts`): one user story per test, titled "As <role>, I …", with spec tags; the happy path plus the refusal a user sees.
- **Visual** (`apps/web/ui`): screenshots in light and dark; update baselines only for intended design changes.
- **Docker** (`*.docker.test.ts`): real containers for the host and runtimes.

Never weaken an assertion to make a test pass; if a check must change, say so in the pull request. No real LLM, identity provider, GitHub or npm call in tests: use the fakes in `apps/server/src/testing/`. In `bun test`, await a promise before asserting on its rejection (`rejectionOf(promise)` in `apps/server/src/testing/testing.ts`) rather than `expect(promise).rejects`.

## Before opening a pull request

Run, and make sure each passes:

```sh
bun run typecheck
bun run lint            # biome; `bunx biome check --write .` fixes formatting and import order
bun run check:boundaries
bun run check:related   # the tests your change affects (unit, integration, e2e)
```

Run `bun run check:all` for changes that touch shared code (`packages/kernel`, `packages/db`, test helpers), and `bun run check:docker` for the host, the agent or the images. Check whether your change makes a page in [docs/](docs/README.md) stale (a decision, a guide step, a feature as users see it); if so, update it in the same pull request, or say in the pull request which page needs a follow-up. Describe in the pull request what changed, why, and how it was tested; include screenshots for UI changes. Keep pull requests to one concern.

## Conventions

- Bun only (`bun install`, `bun run`, `bun test`); the lockfiles are committed and checked by `bun run check:locks`.
- Plain-language UI text, sentences in the user's terms, no internal names.
- Database: every new table has `workspace_id` and the indexes its queries use; migrations are generated with Drizzle and checked by hand.
- Commit messages: `type: what changed and why` (`feat`, `fix`, `perf`, `refactor`, `test`, `build`, `docs`, `chore`).

# Gate register

Every rule of the architecture standard (`.claude/skills/architecture`) and what makes it true here. `bun run check:all` runs every automated gate: Biome, typecheck, dependency-cruiser (`.dependency-cruiser.cjs`), unit tests, build and bundle gates (`scripts/check-bundle.ts`), integration tests, e2e. "Review" means no tool checks it; the reason follows.

## Applied

| Rule | Name | Mechanism |
|---|---|---|
| L1 | Exhaustive layers | depcruise `layers-are-exhaustive` |
| L2 | Direction decides the layer | review: placement is a judgment (server wiring entrypoints are a recorded decision) |
| L3a | Layer import table | depcruise `domain-imports-nothing-above`, `contracts-import-domain-only`, `operations-import-contracts-and-domain`, `queries-import-domain-only`, `integrations-import-contracts-and-domain`, `entrypoints-never-import-integrations` |
| L3b | Siblings never import each other | the same layer rules |
| L4 | Pure domain and kernel | depcruise `domain-imports-no-third-party-package`, `kernel-imports-nothing`; `packages/kernel/package.json` has no dependencies |
| L5 | Vendor SDKs at the edges | depcruise covers `domain/` only (L4 rule); `contracts/` and `operations/` by review |
| L6 | Contracts speak domain types | review: signatures are read, not checked |
| L7a | Business logic in operations and domain | review |
| L7b | Shared mechanics in shared packages | review |
| L8 | No cycles | depcruise `no-cycles` |
| L9a | Read path bypasses operations | depcruise layer rules (only entrypoints may import `queries/`) |
| L9b | Queries return frozen shapes | review |
| L9c | Concrete read path | review |
| L10a | Deciding reads through the unit of work | review: repositories come from each context's `UnitOfWork` |
| L10b | Operations never import queries | depcruise `operations-import-contracts-and-domain` |
| L11 | Bulk access is a declared shape | review |
| B1 | One published surface | depcruise `context-reachable-only-through-its-entries` (entries `client`, `server`, `published`, see `decisions.md`) |
| B2 | No reaching into internals | depcruise `context-reachable-only-through-its-entries`, `contexts-import-each-other-only-from-integrations`, `published-entry-imported-only-from-integrations`, `client-entry-imported-only-by-web`, `server-entry-imported-only-by-server-and-web-composition-root` |
| B3 | Surface documented where published | review: the entry files are the surface |
| B5a | Closed shared layer | depcruise `context-reachable-only-through-its-entries`, `panel-imported-only-by-apps`, `server-imports-only-server-entries-kernel-and-db`; a new shared package by review |
| C1 | Contracts in `contracts/` | review |
| C2a | Interfaces for seams | review |
| C3 | Static conformance | typecheck: every integration factory declares its contract as return type (`createZeroTransactor(...): ProfileTransactor`, `createZeroRuntimeChatStarter(...): RuntimeChatStarter`, ...) |
| C4 | Dependencies as parameters | review |
| C5a | One composition root | depcruise `packages-never-import-apps`, `drizzle-zero-config-imported-only-by-the-generated-zero-schema`; roots are `apps/web/src/app/factory.ts`, `apps/server/src/index.ts` and the server wiring entrypoints |
| C5b | Only the root names implementations | review |
| C6a | Declared scopes | review: transactors are per mutation, the job worker per process |
| C6b | Scope factories and teardown | review |
| V1 | UTC datetimes | review: `timestamptz` columns, epoch milliseconds in Zero |
| V2 | Monotonic durations | review |
| V3 | One type per identifier | typecheck: branded ids in `packages/kernel/src/ids.ts` |
| V4a | Immutable value objects | review |
| V4b | Invariants on construction | unit `domain.test.ts` of workspace (`Name`), conversation (`MessageBody`), profile (`DisplayName`, `Secret`) |
| V6 | Self-redacting values | unit `profile/src/domain/domain.test.ts` "Secret redacts itself in text, JSON and inspection" |
| G3 | Config-derived ids from a map | review |
| G4a | Credentials in a redacting type | `Secret` (V6); integration `profile-mutators` "adding a credential ... logging nothing" |
| S2 | Queries carry a tenant scope | every synced query takes `ctx` (`packages/db/src/zero-queries.ts`); integration `api` "crafted query arguments cannot reach another workspace or member" |
| S3 | Cross-tenant denial tests | integration `constraints` "refuses %s" (cross-tenant writes), `api` crafted queries, `auth` "Bob ... reads Acme only", `workspace-mutators` and `conversation-mutators` "refuses arguments naming another workspace", `api` "a Globex connection stays in Globex" |
| TX1a | Operation owns its boundary | typecheck: operations take the context's `Transactor` and run in `run(work)` |
| TX1b | Repositories from the handle | review: `UnitOfWork` is the only source |
| TX2 | Savepoints | `apps/server/src/job-worker.ts` savepoint per handler; integration `jobs` "a throwing job is retried ..." |
| TX3 | Cross-context change commits together | one Postgres transaction per mutator, no outbox needed while one database serves every context; integration `conversation-mutators` "startRuntimeFromMessage rolls the new chat back ..." |
| TX5b | Idempotent consumers | integration `conversation-mutators` "appends the agent reply exactly once", "two workers never process the same job twice" |
| TX6 | Stated ordering | per-chat `seq` under the chat row lock, unique `(chat_id, seq)`; integration `event-store` "unique gap-free seqs per chat", `conversation-mutators` "30 distinct contiguous seqs", `constraints` duplicate seq |
| TX7 | Retry bound, dead letter, replay | integration `jobs` (5 attempts, `jobs:failed`, `jobs:retry`), `event-store` rebuild tests |
| E1a | Typed error hierarchy with codes | review: `WorkspaceError`, `ConversationError`, `ProfileError` carry `code` |
| E1b | Error kinds are types | review |
| E2 | Context on the original error | review |
| E3 | Re-raise without re-wrapping | review |
| E4 | Security failures propagate | unit `session-tokens.test.ts`; integration `auth` refusals, `app` "%s refuses a request without a bearer token" and `api` "%s refuses with 403 a valid token without membership" on every `/api/*` route |
| E5 | Degradation by contract, by type | review |
| E8 | Inputs validated once at entry | zod mutator schemas in `entrypoints/mutators.ts`; integration `workspace-mutators` "refuses invalid arguments", `profile-mutators` "refuses blank, missing or malformed fields" |
| E9 | Exceptions are the error channel | review |
| RS1 | Retry policy in the operation | review: the job worker owns job retries |
| RS2 | Retries need idempotency | review: a job handler commits with its `done` mark (TX5b) |
| AS1 | No blocking I/O on the loop | review |
| AS2 | No fire-and-forget | review |
| AS4 | Sync or async, not both | review |
| AS5 | Declared synchronization | review: shared state is in Postgres under row locks |
| O6 | Outcome logged once | integration `jobs` "a throwing job is retried ..., then dead" (logged once), `profile-mutators` "logs no secret" |
| T1a | Every collaborator tested | review |
| T1b | Transport fakes only at the transport | review |
| T2a | Units against stubs | review |
| T2b | Substitution through contracts | review: no `mock.module` in the repository |
| T3 | Real dependencies in containers | integration tests on the compose Postgres 18 from a template (`packages/db/src/postgres/test-database.ts`) and one shared zero-cache (`apps/server/src/testing.ts`); e2e on real zero-cache and Dex |
| T9a | Parametrized matrices | review (`test.each` in `constraints.integration.test.ts`) |
| T9b | Composed requests asserted | review |
| T10 | Critical journeys end to end | Playwright `apps/web/e2e/*.spec.ts` against the full stack per worker |
| T11 | No masked flakes | `playwright.config.ts` sets no retries; quarantine by review |
| N2 | Strict type checker | typecheck: `tsconfig.base.json` `strict`, `noUncheckedIndexedAccess`, TypeScript pinned; no `ts-ignore` or `ts-expect-error` |
| N4 | Names state behaviour | review |
| N5 | One verb, one meaning | review |
| N6 | One name per concept | review |

## Project gates

| Gate | Mechanism |
|---|---|
| Main chunk at most 760 kB | `scripts/check-bundle.ts` on `apps/web/dist` |
| No server-only SQL in client assets | `scripts/check-bundle.ts` fails on `into events`, `into sessions`, `skip locked`, `for update`, `into jobs`, `into llm_credentials` or `placeholder_secrets` in any client asset; server SQL that runs in shared mutator code lives in `@hq/db/server-writes`, whose `browser` condition points at stubs |
| `workspace_id` on every table but `users` | integration `schema` "every table except users carries a non-null workspace_id" |
| Append-only events | trigger plus integration `constraints` "rejects UPDATE and DELETE on events" (code and message) |
| Zero publication = Zero schema | integration `schema` "the zero publication replicates exactly ..." |
| Server code never reaches client code | depcruise `server-and-published-entries-never-reach-client-code`, `postgres-drizzle-and-server-never-reach-client-code`, `zero-schema-queries-and-server-writes-never-reach-client-or-server-only-code`; unit `app.test.ts` "loads every context server entry without React or client code" |
| Test code unreachable from production | depcruise `test-only-modules-unreachable-from-production-entries`; integration `auth` "without test hooks ..." |

## Dormant

| Rule | Name | Trigger |
|---|---|---|
| B4a | Versioned incompatible change | a surface with independent consumers (public API, event-triggered agents) |
| B4b | Mechanical incompatibility check | same as B4a |
| V5a | Exact money | billing or budgets (Phase 6); usage cost is mock integer cents today |
| V5b | Currency on money | same as V5a (`Money` in `@hq/kernel`) |
| V5c | One rounding policy | same as V5a |
| G4b | Credentials from a secrets manager | the Gateway (Phase 2) or first deployment |
| G4c | Credential rotation | same as G4b |
| G5 | Flags through a contract | the first runtime flag |
| S7 | Encryption and key custody | the Gateway vault (Phase 2) replacing `placeholder_secrets`; TLS and disk encryption at first deployment |
| — | No `TRUNCATE` on `events` | first deployment: the production role holds no `TRUNCATE` on `events` (the e2e reset needs it) |
| TX4 | Compensations | a cross-context flow spanning transactions or services (Phase 2 orchestrator) |
| E6 | Unwrap aggregated errors | the first task group |
| E7 | Cancellation propagates | the first cancellable work (Phase 2 streaming) |
| RS4 | Retry budget | the first network dependency beyond Postgres (Phase 2 Gateway, Agent Server) |
| RS5 | Deadlines | same as RS4 |
| RS7 | Circuit breakers | same as RS4 |
| AS3 | Async-local scoped state | the first implicitly propagated scope (trace context, Phase 2) |
| T4 | Published fakes | a context consumes another's fake |
| T5 | Consumer-driven contracts | same as B4a |
| T6b | Mutation testing | a claim that every error branch is exercised |

## Never

C2b: TypeScript interfaces do not exist at runtime, so a runtime interface check cannot be written.

## Gaps

Rules that apply today without a mechanism, or with a known hole.

| Rule | Gap |
|---|---|
| S1 | no single policy component: membership is checked in `apps/server/src/auth/session-tokens.ts`, the workspace match in each mutator and transactor; roles arrive in Phase 3 |
| S8 | no secret scan, neither pre-commit nor in `check:all` |
| G2 | `packages/db/src/postgres/client.ts` reads `DATABASE_URL` at module level |
| C7 | same module: importing `@hq/db/postgres` reads configuration |
| TX5a | `POST /api/llm-credentials` takes no idempotency key (Zero mutations are deduplicated by Zero's client mutation ids) |
| RS3 | job retries back off linearly (`attempts * 1 s`) without jitter or cap |
| RS6 | the postgres.js pool is bounded (default 10) but has no statement timeout |
| RS8 | no retry of serialization or deadlock failures around a mutator (only the e2e reset retries `40P01`) |
| O1, O2a, O2b, O3, O4, O5, O7 | no OpenTelemetry: server logs are plain `console` lines without trace ids, no spans, no `traceparent` across browser, server and zero-cache |
| T6a | no coverage measured |
| T7 | no property-based state machine for the event store or the transactors |
| N1 | return types are inferred, not annotated (`isolatedDeclarations` is off) |
| N3 | Biome `noExplicitAny` is only a warning, and warnings do not fail; zero explicit `any` today |

Known holes in applied rules: L5 is mechanical for `domain/` only; B5a does not catch a new shared package; T10's suite (212 tests) is wider than a bounded set of journeys.

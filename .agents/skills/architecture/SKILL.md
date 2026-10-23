---
name: architecture
description: |
  Architecture standard for a monorepo — bounded contexts with inward-pointing layers,
  consumer-owned contracts, explicit transaction boundaries, OpenTelemetry observability.
  Load when adding a context or package, deciding where code belongs, designing a contract or
  transaction boundary, handling errors or retries, emitting logs, or reviewing any of these. Rule detail lives in referenced files; read only the group you need.
---

# Architecture standard

Bounded contexts, each containing inward-pointing layers. Rules are numbered (`L3a`, `TX4`) so
review comments can cite them.

Adopt on a greenfield repository from the first commit — every contract is cheapest to enable when
there is nothing to migrate.

## Structure

```
src/
  billing/                  # a bounded context
    domain/                 # entities, value objects, invariants
    contracts/              # interfaces the inner layers require
    operations/             # application logic — one operation per unit of work
    queries/                # read models — query-shaped DTOs, may contain SQL
    integrations/           # outbound: what an operation calls out to
    entrypoints/            # inbound: what calls in, and its request-scoped wiring
  claims/
  kernel/                   # shared value types, importable by every context
```

The import permissions per layer are the table under `L3a` in
[`references/layering.md`](references/layering.md), which is the enforceable statement.
`integrations/`, `operations/`, and `queries/` are siblings: none may import another.

## The three placements that are not guessable

**Direction decides the layer, not technology.** Anything that *drives* the system is an entrypoint
— HTTP route, CLI command, queue consumer, webhook receiver, scheduled worker — and may invoke
operations. Anything the system *calls out to* is an integration. A Kafka consumer and a Kafka
producer live in different layers, and neither is misplaced. An integration never invokes an
operation.

**Operations read freely inside their transaction, never through `queries/`.** Reads an operation
needs for a decision go through a repository contract inside its own transaction boundary, where the
data is authoritative. `queries/` is the non-transactional read path serving the outside world and
may lag the write model. The distinction is staleness, not SQL.

**`domain/` and `kernel/` have no third-party dependency at all** — not even a validation library.
Boundary validation happens in `entrypoints/`.

## Principles

**P1 — Dependencies point inward.** Business rules must not depend on the technology that delivers
them. The direction of every import is a design decision, not an accident.

**P2 — Contracts are owned by the consumer.** The code that needs a capability declares its shape;
the code that provides it conforms. Ownership in the other direction re-couples the inside to the
outside and is indistinguishable from having no boundary.

**P3 — Composition is explicit and in one place.** What is connected to what in production must be
answerable by reading one module, without tracing import side effects.

**P4 — Failures are typed and travel.** An error's cause, stack, and data survive
intact to the layer that decides the outcome. Information discarded at the raise site cannot be
recovered during an incident.

**P5 —** Deprecated: retired, kept so existing citations stay valid.

**P6 — Automated control beats judgment.** A rule checked by CI holds at any team size; a rule that
depends on a reviewer noticing decays as the codebase grows. Automate what can be automated, and
state honestly which rules rest on review.

## Where the rules live

Read the group the task touches, not all of them.

| Read | When |
|---|---|
| [`references/boundaries.md`](references/boundaries.md) — `B` | what one context may see of another |
| [`references/concurrency.md`](references/concurrency.md) — `AS` | async, structured concurrency, shared state |
| [`references/config-flags.md`](references/config-flags.md) — `G` | configuration, secrets, feature flags |
| [`references/contracts-dependencies.md`](references/contracts-dependencies.md) — `C` | defining a seam, wiring dependencies |
| [`references/errors.md`](references/errors.md) — `E` | raising, propagating and tolerating failure |
| [`references/layering.md`](references/layering.md) — `L` | placing a module, ordering imports inside a context |
| [`references/naming-typing.md`](references/naming-typing.md) — `N` | annotations, strict mode, names |
| [`references/observability.md`](references/observability.md) — `O` | logging, tracing, metrics |
| [`references/resilience.md`](references/resilience.md) — `RS` | retries, timeouts, deadlines, breakers |
| [`references/security.md`](references/security.md) — `S` | authorization, tenant scoping, encryption |
| [`references/testing.md`](references/testing.md) — `T` | writing tests, fakes, coverage |
| [`references/transactions.md`](references/transactions.md) — `TX` | transaction boundaries, the outbox, sagas, idempotency |
| [`references/values-primitives.md`](references/values-primitives.md) — `V` | value types, datetimes, money, identifiers, redaction |
| [`standard.md`](standard.md) | the reviewer's view: controls per rule, the reference dependency contract, waivers, annexes, glossary |

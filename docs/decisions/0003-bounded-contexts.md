# 0003. Bounded contexts with inward-pointing layers

## Context

Spyria spans sign-in and roles, chats, agent runtimes, money and a dev workflow. Without boundaries, every feature would reach into every table, and a change to one area would ripple into the others.

## Decision

- One package per bounded context under `packages/` (`workspace`, `conversation`, `runtime`, `profile`, `usage`, `panel`), each with the same layers: `domain`, `contracts`, `operations`, `queries`, `integrations`, `entrypoints`. Dependencies point inward, toward `domain`.
- Contexts reach each other only from `integrations/`, through the other context's `published.ts`. Apps reach a context only through its `client.ts` (web) or `server.ts` (server).
- A closed shared layer: contexts may import only `@spyria/kernel`, `@spyria/db`, `@spyria/ui` and `@spyria/session`, which hold no business rules.
- `apps/host` and `apps/agent` import nothing from Spyria and nothing imports them; their wire frames are their contract with the server.
- `bun run check:boundaries` (dependency-cruiser) enforces all of this.

## Consequences

- A new contributor learns one context and knows the shape of all of them.
- A boundary violation fails the build and is treated as a design problem.
- Some wiring is more explicit than in a single module tree. The server-only wiring files (`entrypoints/mutators.ts`, `jobs.ts`, `endpoints.ts`) may bind operations to integrations; nothing else in `entrypoints` may.
- The host and the agent ship as small, self-contained programs on machines Spyria does not control.

See [contexts](../architecture/contexts.md).

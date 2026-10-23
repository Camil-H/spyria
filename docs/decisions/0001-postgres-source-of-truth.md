# 0001. Postgres is the source of truth, the event store and the job queue

## Context

Spyria needs a relational data model (workspaces, members, chats, roles, budgets), a durable history of what happened in each chat, and background work (starting runtimes, running agent turns, syncing usage, sweeping expired sessions). Each of these is often given its own system: a database, an event store or log, and a message broker.

## Decision

Postgres holds all three.

- The data model is Drizzle tables, changed only through Drizzle migrations. A migration that has shipped is never edited.
- Chat history is an append-only `events` table; a trigger rejects updates and deletes. The `messages` table is a projection of it and can be rebuilt (`bun run db:rebuild-messages`).
- Background work is a `jobs` table. Workers claim jobs with `for update skip locked`, retry with backoff up to five attempts, and leave dead jobs for an operator to inspect and requeue.

## Consequences

- An operation can write its rows, its events and the jobs it starts in one transaction, so either all of it happens or none does. There is no "row written but message lost" state to reconcile.
- One system to run, back up and monitor. A self-hosted instance is Postgres plus stateless processes.
- The queue polls; it is not built for very high job rates. That is acceptable for agent turns, whose cost is dominated by model latency.
- Every table carries `workspace_id`, which keeps scoping explicit in every query (see [security](../architecture/security.md)).

## Alternatives considered

- A separate broker (for example Redis or a managed queue): another system to operate and a second place where state can disagree with the database.

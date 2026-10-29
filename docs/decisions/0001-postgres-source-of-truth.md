# 0001. Postgres is the source of truth, the event store and the job queue

## Context

Spyria needs a relational data model (workspaces, members, chats, roles, budgets), a durable history of what happened in each chat, and background work (starting runtimes, running agent turns, syncing usage, sweeping expired sessions). Each of these is often given its own system: a database, an event store or log, and a message broker.

## Decision

Postgres holds all three.

- The data model is Drizzle tables, changed only through Drizzle migrations. A migration that has shipped is never edited.
- Chat history is an append-only `events` table; a trigger rejects updates and deletes, with two exceptions: the deletes of a workspace being erased after its deletion, and, when a member deletes a message, blanking its text and dropping its attachments (their names, types and sizes) in the earlier `message.posted`, `message.replied` and `message.edited` events of that message (body set to empty, `attachments` removed and `redacted` set to true, nothing else changed, and only for a message already deleted, in a transaction that names it). The event's type, order and author stay, so the history can still be rebuilt and a deleted text is truly erased. The `messages` table is a projection of it and can be rebuilt (`bun run db:rebuild-messages`).
- Background work is a `jobs` table. Workers claim jobs with `for update skip locked` and hold them under a five-minute lease that a running job keeps extending, so only a worker that died loses its job to another. A trigger sends `NOTIFY jobs_queued` when a job becomes due, which wakes idle workers at once; delayed jobs are found by a one-second poll. Workers retry with backoff up to five attempts, and leave dead jobs, with the time they failed, for an operator to inspect and requeue.

## Consequences

- An operation can write its rows, its events and the jobs it starts in one transaction, so either all of it happens or none does. There is no "row written but message lost" state to reconcile.
- One system to run, back up and monitor. A self-hosted instance is Postgres plus stateless processes.
- The queue is not built for very high job rates. That is acceptable for agent turns, whose cost is dominated by model latency.
- Every table carries `workspace_id`, which keeps scoping explicit in every query (see [security](../architecture/security.md)).
- The event store has exactly two exceptions to append-only, both enforced by the event trigger rather than by convention: the purge of a deleted workspace, and the redaction of a deleted message's text and attachment names. They exist because a history that can never lose a word cannot honour a deletion: without them, a secret posted by mistake, or the data of someone who asks for it to be removed, would stay on the server forever. Each lets through only its one change (deletes of a workspace due for purge; blanking the body and dropping the attachments of an already deleted message, in a transaction that names it), so the history keeps its order and can still be rebuilt. Removing either would bring back undeletable data; adding a third needs its own decision.

## Alternatives considered

- A separate broker (for example Redis or a managed queue): another system to operate and a second place where state can disagree with the database.

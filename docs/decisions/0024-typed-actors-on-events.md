# 0024. Events record a typed actor and the member it acts for

## Context

Chat events and workspace events recorded a single `actor` text, filled with a member id. Everything else that acts in a workspace had no identity: agent events and turn notices were written with no actor, a GitHub webhook moving a pull request had none, the budget alert job had none, the operator CLI wrote the made-up id `operator`, and an agent's push was recorded as if the owner had pushed it by hand. The audit log showed all of these as "System" and could not tell an agent from a job.

## Decision

- An actor is typed (`Actor` in `packages/kernel/src/actors.ts`): a **member** (their id), an **agent** (the runtime chat it runs in), a **system** job (the job's name, such as `workspace.purge`, `budget.alerts`, `agent.turn`, `operator`) or an **integration** (`github`).
- The member an agent, job or integration acts for is kept apart, in `on_behalf_of`, as model and tool calls already keep the prompter apart from the owner ([0004](0004-members-keys-through-a-gateway.md), [0009](0009-agent-acts-as-the-owner.md)). A member actor has no `on_behalf_of`.
- `events` and `workspace_events` carry `actor_kind` and `on_behalf_of` next to the existing actor id. Operations a member runs from a mutator keep taking a `MemberId` and record a member actor; operations that something else can run (publishing a branch, recording a pull request, turn notices, agent events) take an `Actor`.
- The event store stays append-only: chat events written before this change are not rewritten. A chat event without `actor_kind` reads as a member when it has an actor id and as the system otherwise. Workspace events, which the trigger does not guard, were backfilled.
- A message's author is the member behind the actor: an agent's pull request card keeps the owner it acts for as its author, so the chat still finds its card, while notices have no author.

## Consequences

- The audit log names who acted: "Alice", "Alice's agent", "System, for Alice" or "GitHub". Filtering by a person also lists what was done on their behalf.
- An agent's tool calls read as the prompter's agent rather than the prompter.
- Adding a new kind of actor (a service identity owning chats, a ticket intake) means a new `Actor` case, not a fake member id.

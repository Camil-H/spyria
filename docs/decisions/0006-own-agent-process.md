# 0006. Spyria's own agent process, with Pi for API-key chats

## Context

Inside a runtime, something must start the agent, pass it prompts, stream its events, ask the member questions, stop a turn and resume after a restart. An off-the-shelf agent server would do part of this, but it bundles its own versions of the coding agents, auto-approves everything without letting the client ask the member, and needs translation layers for its event shapes.

## Decision

- `spyria-agent`, a small Bun program, is the entrypoint of Spyria's runtime image. One process per runtime, several conversations (sub-agents run as sub-conversations in the same runtime).
- It speaks to the server over a small HTTP and WebSocket API, and to the coding agent over stdio: Pi through Pi's RPC mode, Claude Code and Codex through their Agent Client Protocol adapters.
- It numbers every event and keeps a bounded buffer per conversation, so a reconnecting server gets what it missed.
- Chats on workspace runtimes always run **Pi**, on the prompting member's API keys, for every provider. Spyria's routing chooses and switches models inside one Pi session.
- Claude Code and Codex run only on a member's own machine, on their subscription ([0007](0007-subscriptions-on-the-members-machine.md)).

## Consequences

- Questions to the member and Stop work the same way for every harness, through one bridge.
- Each coding agent's version is pinned by Spyria and updated deliberately (`bun run agent:versions`, `bun run agent:bump`).
- Spyria owns a few hundred lines of protocol code instead of a large dependency.
- A new harness is one registry entry in the kernel plus its real differences.

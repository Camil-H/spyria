# 0007. Subscription harnesses run on the member's own machine

## Context

Many members already pay for a Claude or ChatGPT plan and want to use it in Spyria. The providers' terms do not let a third-party service collect, store or relay those sign-ins, and account sharing is forbidden. An end user may, however, run the unmodified Claude Code or Codex on their own machine with their own sign-in.

## Decision

- A member can add their own machine (Profile, **My machine**). It runs the same `spyria-host` in personal mode and dials out like any host.
- The member signs in to Claude Code or Codex on that machine. The sign-in stays in a Docker volume there; Spyria's server never receives it.
- Claude Code, Codex and their adapters are not in Spyria's image. The member's host installs the pinned versions from npm on first use into a volume on that machine and mounts it read-only into the session.
- Only the owner prompts these sessions; other members can read them. They run on the plan's default model, without Spyria's routing, keys or metering.
- Admins can turn these sessions off for the workspace.

## Consequences

- The agent in such a session can read the sign-in, as it could on the member's laptop. Isolating it would need relaxed sandboxing and still leave gaps, so the host protects the boundary instead: it forwards only the requests Spyria needs and redacts token formats and current token values from everything it sends.
- Never run personal mode on a machine others use.
- Usage on these sessions does not appear in Spyria's spend or budgets.
- Spyria redistributes no proprietary harness.

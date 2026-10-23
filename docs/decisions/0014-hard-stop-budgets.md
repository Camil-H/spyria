# 0014. Budgets are a hard stop at the relay

## Context

Admins need to cap spend per member and per workspace. Alerts alone do not stop a runaway agent loop; a check in the UI does not stop a turn that is already running.

## Decision

- Budgets are monthly limits for the workspace and for individual members.
- Every model call passes through Spyria's relay, which refuses the call when the prompter's budget or the workspace's is used up, and the chat says why.
- Spend comes from the gateway's logs, synced every few seconds into Spyria's records.
- Members see their own usage and budget in their profile; admins with `costs.view` and `budgets.manage` see and set the rest.

## Consequences

- One enforcement point covers every harness that goes through the gateway.
- Because spend is synced after the fact, calls already in flight can overshoot a limit slightly.
- Sessions on a member's own machine use their subscription and are not counted.

See [admin](../features/admin.md#budgets).

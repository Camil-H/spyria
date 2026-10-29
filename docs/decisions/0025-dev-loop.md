# 0025. The dev loop: server-run steps between the agent's turns

## Context

A dev chat today stops at the agent's own judgement: it writes code, maybe runs the checks it thinks of, and the owner finds out on the pull request whether lint, types, tests or CI pass. Every round trip after that ("fix the failing test", "address the review comments", "resolve the conflicts") is a prompt the owner types or a button they press. Large teams that run coding agents at scale converged on the same shape: deterministic steps the orchestrator runs itself, interleaved with agent turns, with a hard cap on rounds and a human at the end ([Stripe's minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) allow at most two CI rounds; [Anthropic's code review](https://claude.dev/blog/solving-code-review-at-anthropic) caps author–reviewer rounds at three after one pull request went through more than 50 rounds overnight, mostly on code that predated it).

Nothing in Spyria starts a turn without a member's prompt, and publishing is reserved to the owner's own prompts ([0011](0011-publishing-through-server-side-bundles.md)). The setup script ran alongside the first turn with no time limit and never again after a restart.

## Decision

- **The loop is the chat's own turns, not a new entity.** After an agent turn, the server runs the steps the repository defines and, when one fails, prompts the agent again. Each prompt records whether a member or the loop sent it; the loop's state (phase, round counters, findings) is one structured step on the member's prompt that started it. The loop runs in every dev chat, on Spyria's runtimes and on members' machines alike, since both run the same `spyria-agent`.
- **Automatic turns count as the chat owner's prompts.** They use the owner's key and budget and may publish, like the owner's own prompts; the event records a system actor acting on behalf of the owner ([0024](0024-typed-actors-on-events.md)). Only the owner's own prompts start a loop: a guest's prompt runs as one turn with the guest's rights, as before ([0009](0009-agent-acts-as-the-owner.md)), so nobody gains the owner's key, budget or push through someone else's chat. A ticket-started loop (v2, its own decision) uses the ticket's assignee as the owner.
- **The agent ends the work explicitly** by calling `finish_work` with the pull request's title and summary; it is a tool on the `github` tool server, which every harness gets. The server then verifies the claim: local checks, then review, then push and open or update the pull request, then CI. A failure sends the agent back with the failure as untrusted tool output, and the agent calls `finish_work` again when it is done. A turn that ends without `finish_work` means the agent is waiting for the owner: the loop pauses, with no automatic turn and no push.
- **Where settings live.** The repository's `.spyria/` holds the setup script, the check commands, `REVIEW.md` and the CI checks that count. The admin's **Dev loop** settings say whether the loop may run and set its limits. Members bring their own models, so the workspace never picks a model for a step.
- **The loop converges.** Each phase has a round cap (local checks 3, review 3, CI 2 by default), the loop has a wall-clock limit, and API-key chats have a cost limit per loop; on a member's machine, subscriptions are not metered, so only the round and time limits apply. The last allowed round asks the agent to say what it would change about the approach instead of fixing again. The reviewer reports only verified, severity-tagged findings on the new diff; findings on code that predated it never block, and a finding is never repeated. Any limit, or all green, hands off to the owner with a notice: "ready for your review", never "approved".
- **Members come first.** A member's prompt cancels a queued automatic turn, and an automatic turn never runs ahead of a waiting member prompt. The budget is checked before each automatic turn starts, not only at the relay ([0014](0014-hard-stop-budgets.md)).
- **CI results:** a check-run webhook tells when; `read_checks` tells what. The loop feeds the agent what that tool already reads ([0021](0021-ci-on-github-actions-through-develop.md)): the failing checks' annotations and, for a GitHub Actions job, the failed step and the end of its log. Only the checks `.spyria/` names count, and a pending check never uses up a round.
- **Setup comes first.** Prompts wait for the setup script; it has 45 minutes, after which its process group is stopped; it runs again each time the runtime starts. This part ships with this record; the rest is the plan that later changes follow.

## Consequences

- Publishing is no longer only on the owner's typed prompt: an automatic turn may push, but only after `finish_work` and green local checks. The owner turned this on by working in a dev chat of a workspace whose admin allowed the loop.
- An App that has not accepted `actions: read` gives the loop annotations only, as it does `read_checks`.
- CI logs and test output reach the owner's model provider. GitHub masks the secrets it knows about; anything else a job prints goes along.
- Setup scripts must be safe to run twice.
- The order of work: setup that prompts wait for; a checks card with **Ask the agent to fix**; automatic turns for local checks; `finish_work`, push and CI; the reviewer. Ticket intake comes after, with its own decision.

See [Dev mode](../features/dev-mode.md#clone-and-setup-script).

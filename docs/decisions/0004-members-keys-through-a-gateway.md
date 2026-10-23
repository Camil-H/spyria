# 0004. Members bring their own model keys, through one gateway

## Context

Spyria is model-agnostic and serves organizations of any size. Someone has to pay for model calls, and someone has to be accountable for what an agent does with the organization's tools. A shared organization key hides who spent what; per-provider plumbing in Spyria would mean storing provider keys in its own database.

## Decision

- Each member adds their own provider API keys in their profile. A prompt runs on the key of the member who sent it, the **prompter**.
- Keys live in a self-hosted model gateway (Bifrost), never in Spyria's database; Spyria keeps a reference and the last four characters.
- The gateway runs next to the server, never on runtime hosts, because hosts may be run by other people.
- A runtime never holds a member's key. It holds a token Spyria issues per runtime; Spyria's relay swaps it for the prompter's key during an active turn and adds the chat, prompter and owner as attribution labels.
- Every model call is recorded with its prompter and the chat's owner. Tool calls go through the same gateway on the owner's connections ([0009](0009-agent-acts-as-the-owner.md)).

## Consequences

- Cost lands on the person who caused it, and spend per member, chat and workspace comes for free.
- A member without a key can read chats but cannot prompt until they add one.
- In a shared chat, turns by different members use different keys, so provider prompt caches are not shared between them.
- Budgets can be enforced in one place, the relay ([0014](0014-hard-stop-budgets.md)).

## Alternatives considered

- LiteLLM: avoided after a supply-chain incident in its distribution.
- One workspace key: simpler, but no per-member accountability.

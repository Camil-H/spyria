# 0009. The agent acts as the chat owner; guests get the intersection

## Context

An agent with tools can read and change things in other systems (a CRM, a repository, a wiki). When several members share a chat, someone must be accountable for each action, and nobody should gain rights through someone else's chat.

## Decision

- The agent's tool calls use the **owner's** connections: the workspace connections the owner may use and the owner's personal connections.
- On a **guest's** prompt (an Editor or Prompter), the agent may use only the workspace connections that both the owner and the guest may use, and never the owner's personal connections.
- A guest-initiated tool call that is not marked read-only waits for the owner's approval in the chat.
- Model calls run on the prompter's key ([0004](0004-members-keys-through-a-gateway.md)). Every tool call, like every model call, records prompter and owner.
- Sessions on a member's own machine accept prompts from their owner only.

## Consequences

- The agent never does more than the person prompting could do, and the owner is never answerable for an action they did not approve.
- One identity is accountable for each action, which keeps the audit trail readable.
- Shared chats are slower for guests who need write tools, by design.

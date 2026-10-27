# 0023. Every member's gateway key serves tools, with or without a model key

## Context

The gateway scopes tool calls by a member's virtual key: the workspace connections they may use and their personal connections live on it. Spyria created that key only once a member added a provider key, and deleted it with their last one. A member running Claude Code or Codex on their own subscription never needs a provider key in Spyria, so their sessions reached Spyria's tool server without any key behind it, and the agent reported the runtime token as rejected. Workspace tools belong to the workspace, not to whoever pays for models.

## Decision

- An active member gets a virtual key the first time they need tools (their agent connects to Spyria's tool server, or they connect a personal tool), with no provider bound to it.
- Removing a member's last provider key unbinds it and keeps the virtual key, its workspace grants and their personal connections.
- The virtual key is deleted only when the member leaves the workspace or the workspace is purged.
- Model calls still need a provider key: Spyria refuses a prompter without one before the gateway, whatever the gateway does with a key that binds no provider.

## Consequences

- Workspace tools and personal connections work for every member, including on their own machine, and survive removing and adding provider keys.
- The gateway holds a virtual key per member who used tools, not only per member with a provider key.
- A member without a provider key still cannot prompt on a Spyria runtime ([0004](0004-members-keys-through-a-gateway.md)).

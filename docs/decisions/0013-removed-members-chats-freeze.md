# 0013. A removed member's chats freeze and can be transferred

## Context

An agent chat acts with its owner's connections and is paid with its prompters' keys. When the owner leaves the workspace, their chat can no longer act as anyone, but its history may still matter to the people who worked in it.

## Decision

- When a member is removed, their sessions end, their open streams close, their machines disconnect, and their agent chats freeze: participants can still read them, nobody can prompt them, and their runtimes stop.
- A member with `members.manage` can transfer a frozen chat to another member, who becomes its owner.
- Channels never freeze: they belong to the workspace, not to a person.

## Consequences

- No agent ever acts in the name of someone who has left.
- Knowledge in those chats is not lost, and work can continue under a new accountable owner.

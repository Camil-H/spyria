# Chats and sharing

This page describes how conversations are organized in a Spyria workspace and how members share them: projects, channels, runtime chats, threads, unread state, chat roles, forking and starting an agent from a channel thread. It is written for members and for contributors who need the rules the server enforces. Agent behaviour inside a runtime chat is in [Agents](./agents.md); dev chats on repositories are in [Dev mode](./dev-mode.md).

## Projects and chats

The sidebar lists a workspace's **projects**, each with its chats, then the **Loose chats** that belong to no project. **New project** and **New chat** sit at the top of the sidebar.

A chat has one of two types, chosen in **New chat**:

| Type | Who talks | Visibility | Notes |
|---|---|---|---|
| **Channel** | members only | **Public** or **Private** | threads, "Start runtime from this message" |
| **Runtime** | members and an agent | always private | **Non-dev** or **Dev** mode; dev chats need a GitHub repository |

The member who creates a chat owns it, and stays its owner. Ownership matters beyond the chat itself: the agent of a runtime chat acts with its owner's tool connections (the header says **Agent acts as** *owner*), so there is always one accountable identity for what the agent does. See [Security](../architecture/security.md).

From a chat's menu in the sidebar, a member with the right permission can **Move to** another project (or **No project**), rename, **Make private** / **Make public** (channels only), **Archive chat**, or leave (**Leave channel**, **Leave chat**). Archiving a chat also removes its runtime. **Archive project** offers two choices: **Archive with its chats**, or **Archive, keep chats**, which moves them to Loose chats.

Every chat keeps one unsent draft per member; a pencil icon in the sidebar marks a chat with a draft. In the composer, Ctrl+Enter (Cmd+Enter on a Mac) sends.

## Channels

Channels are where members talk without an agent. A **public** channel is open to every member of the workspace: anyone can read it, and anyone can post after **Join channel**. **Browse channels** in the sidebar lists the public channels a member has not joined. A **private** channel is visible only to its participants.

Changing a channel's visibility needs the chat admin permission. When a channel becomes public, any participant whose role gives less than read and post (a Reader) becomes a Prompter, because a public channel already lets everyone post.

## Threads

In a channel, the message menu of a top-level message offers **Reply in thread**. Replies stay under their root message, collapsed behind a toggle such as "3 replies · 1 new"; they never appear in the channel flow. Replies are ordinary messages: their authors can edit or delete them, and a deleted root keeps its thread. Runtime chats have no threads, and the server refuses a reply there.

## Unread state

A chat with messages a member has not seen shows an **Unread messages** icon in the sidebar. Opening the chat marks it read. In channels only top-level messages count: a new reply never makes the channel unread. Each thread keeps its own read marker per member; opening a thread marks it read, and its toggle shows how many replies are new.

## Sharing a chat and chat roles

A chat's participants and their roles are in the **Members** tab of the side panel, where a member with the right permissions can **Invite** another workspace member with a role, change a participant's role, or **Remove** them (private chats only). Anyone but the owner can **Leave chat**.

A role is a named set of permissions. Spyria ships four built-in chat roles; admins can add custom chat roles in Workspace settings (see [Admin](./admin.md)).

| Permission | What it allows | Owner | Editor | Prompter | Reader |
|---|---|:-:|:-:|:-:|:-:|
| `chat.read` | Read the chat | yes | yes | yes | yes |
| `chat.post` | Post and prompt the agent | yes | yes | yes | |
| `session.configure` | Choose the model and stop the agent | yes | yes | | |
| `members.invite` | Invite people to the chat | yes | yes | | |
| `members.manage` | Change roles and remove people | yes | | | |
| `tools.manage` | Manage the chat's tools | yes | | | |
| `chat.admin` | Rename, move and archive the chat, change its visibility | yes | | | |

The server applies these rules on every request:

- **Nobody grants more than they hold.** A member can only give a role whose permissions are all within their own.
- **The Owner role is not assignable**, and the owner keeps it and stays in the chat.
- **Public channels are open to all.** In a public channel every member already reads and posts, so a role below that (Reader) cannot be given there: make the channel private to restrict someone.
- **Members outside the workspace cannot be invited.**

The `tools.manage` chat permission is defined and shown in the roles editor, but no chat action checks it yet.

### Prompts from someone other than the owner

When a participant other than the owner prompts the agent, the agent still acts as the owner, but with less reach, so it never exceeds what the prompter could do and the owner is never answerable for actions they did not approve:

- The owner's **personal connections** are not available on a guest's prompt.
- A **workspace connection** is available only if both the owner and the prompter may use it.
- A tool call that is not read-only (the tool does not declare the MCP `readOnlyHint`) waits for the **owner's approval**. The owner sees a **Tool approval** card with Approve and Deny; everyone else sees that it is waiting. Without an answer within 5 minutes the call expires. Deny, expiry or **Stop** answer the agent that the owner did not approve the call.
- Model calls always run on the **prompter's own key**, never the owner's (see [Agents](./agents.md)).

Every tool call is recorded with its prompter, owner and approval decision, and appears in the audit log.

## Forking a runtime chat

**Fork into my session** in a runtime chat's header creates a new runtime chat owned by the member who forked it, in the same project. Any participant who can read the chat can fork it; the owner sees the button too. The fork starts with one message that quotes the conversation so far (members' messages and the agent's replies, with their authors and times), and its header links back with "Forked from". A fork is the way to continue someone else's work with your own tools, machine or model.

Only runtime chats can be forked.

## Starting a runtime from a channel thread

In a channel, every message's menu has **Start runtime from this message**. It creates a runtime chat owned by the member who chose it, named from the message, and seeded with the whole thread (the root and its replies) as quoted context. The other authors of the thread who can read the channel join the new chat as Readers. The channel message shows a link to the runtime chat it started, and the runtime chat links back with "Started from".

This lets members discuss freely in a channel and bring an agent in only when there is work to do, without moving the conversation by hand.

## When a chat owner leaves the workspace

When an admin removes a member, that member's runtime chats are **frozen**: they show "This chat is frozen: its owner left the workspace", and nobody can prompt in them, because the agent would otherwise act with a departed member's identity. An admin can **Transfer** a frozen chat to an active member, who becomes its owner. Channels never freeze. See [Admin](./admin.md).

## Side panel

The side panel next to a chat has tabs that depend on the chat type. Runtime chats have **Files**, **Changes**, **Plan**, **Commits**, **Browser**, **Usage**, **Connected tools** and **Members**; channels have **Browser**, **Sources**, **Usage**, **Connected tools** and **Members**. **Usage** breaks down the chat's model spend per member, and **Connected tools** lists the workspace and personal connections the agent can use. The dev tabs are described in [Dev mode](./dev-mode.md). **Browser** and **Sources** are placeholders: nothing fills them yet.

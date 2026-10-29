# Chats and sharing

This page describes how conversations are organized in a Spyria workspace and how members share them: projects, channels, runtime chats, threads, search, keyboard shortcuts, unread state, chat roles, forking and starting an agent from a channel thread. It is written for members and for contributors who need the rules the server enforces. Agent behaviour inside a runtime chat is in [Agents](./agents.md); dev chats on repositories are in [Dev mode](./dev-mode.md).

## Projects and chats

The sidebar lists a workspace's **projects**, each with its chats, then the **Loose chats** that belong to no project. **New project** and **New chat** sit at the top of the sidebar, above **Search**.

A chat has one of two types, chosen in **New chat**:

| Type | Who talks | Visibility | Notes |
|---|---|---|---|
| **Channel** | members only | **Public** or **Private** | threads, "Start runtime from this message" |
| **Runtime** | members and an agent | always private | **Non-dev** or **Dev** mode; dev chats need a GitHub repository |

The member who creates a chat owns it, and stays its owner. Ownership matters beyond the chat itself: the agent of a runtime chat acts with its owner's tool connections (the header says **Agent acts as** *owner*), so there is always one accountable identity for what the agent does. See [Security](../architecture/security.md).

From a chat's menu in the sidebar, a member with the right permission can **Move to** another project (or **No project**), rename, **Make private** / **Make public** (channels only), **Archive chat**, or leave (**Leave channel**, **Leave chat**). Archiving a chat also removes its runtime. A project's menu offers **New chat**, which opens the new chat dialog with that project already chosen, **Rename project** and **Archive project**. **Archive project** offers two choices: **Archive with its chats**, or **Archive, keep chats**, which moves them to Loose chats.

Every chat keeps one unsent draft per member; a pencil icon in the sidebar marks a chat with a draft. In the composer, Ctrl+Enter (Cmd+Enter on a Mac) sends.

A chat opens on its newest message and follows new ones as they arrive. A member who scrolls up to read earlier messages stays where they are when new ones come in, and a **Go to last message** button at the bottom of the chat takes them back down; sending a message also goes back to the newest.

Messages are written in Markdown and shown formatted; in a member's message, each new line stays a new line. In the composer, Ctrl (Cmd on a Mac) plus **B**, **I** or **U** makes the selection bold, italic or underlined (`__text__`), Ctrl+Shift+C makes it code (a block when it spans several lines), and Ctrl+K makes it a link; pressing the same shortcut again removes the formatting. A line starting with `- ` or `1. ` continues as a list on Enter, and Enter on an empty item ends the list. Pasting a web address over selected text makes a link. Shift+Enter always adds a plain new line.

Each message shows its author's picture next to their name, and the agent's replies a small robot. A member sets their picture per workspace in **Profile**, where it sits left of the display name: clicking the picture adds one, or, once set, opens **Change picture** and **Remove picture**; without one, their initials show. The browser crops the image to a square and shrinks it to 96 pixels before sending it, and the server accepts only a small PNG, JPEG or WebP image. Every member of the workspace can see it.

Typing **@** in the composer lists the workspace's members, narrowed as the name is typed; the arrow keys move through the list, Enter or Tab (or a click) puts the name in the message and Escape closes the list. In a message, a mention of a current member (`@Name`) shows in bold. Mentions only highlight the name: they send no notification and give the member no access to the chat.

The author of a message can edit or delete it from its actions. A deleted message stays in the chat as "This message was deleted", and its attachments are erased. Its text no longer reaches any member's browser, and the server erases it from the chat's history, the text it was posted with and every edit. Only its last text is kept, apart from the chat: members who can view the audit log read it as a **Deleted a message** record (see [Admin](./admin.md#audit-log)) until the audit retention erases it. Copies made before the deletion stay: a quote of the message in a chat started from it, and what the agent already received.

The paperclip next to **Send** attaches up to six files of up to 20 MB each: images (PNG, JPEG, GIF, WebP), sounds, videos (MP4, WebM, QuickTime) and PDFs. Pasting or dropping a file into the composer attaches it too. The server checks each file's content, not its name, and refuses anything else (SVG and HTML included). Images show in the message once they scroll into view; sounds, videos and PDFs load only when a member clicks them. Only members who can read the chat can open its attachments, and deleting a message erases them. Files attached but never sent are erased after a day. A member can hold up to 120 MB of unsent files, and a workspace stores up to 10 GB of attachments.

In a runtime chat, the agent can show a file it made, or a screenshot it took with `take_screenshot` (see [Agents](./agents.md#screenshots)), by writing a Markdown image with the file's path in its workspace, such as `![Sales chart](out/chart.png)`. The server fetches the file from the runtime through its existing host connection, checks that it is an image, a sound or a video of up to 20 MB, and shows it inline. The first four such images of a message load on their own; later ones load on click. Such files show only while the runtime is running. On a member's own machine, a file that holds one of that member's sign-in tokens is not shown.

An image with a web address in a message shows as a **Load image from** *site* button and loads only on click, from the viewer's browser, so that site sees the viewer's address. Once loaded, the same image stays loaded in that chat until the page is reloaded, also when the agent's reply that holds it is stored or folded into its steps.

## Channels

Channels are where members talk without an agent. A **public** channel is open to every member of the workspace: anyone can read it, and anyone can post after **Join channel**. **Browse channels** in the sidebar lists the public channels a member has not joined. A **private** channel is visible only to its participants.

Changing a channel's visibility needs the chat admin permission. When a channel becomes public, any participant whose role gives less than read and post (a Reader) becomes a Prompter, because a public channel already lets everyone post.

## Message actions

In a channel, pointing at a message, or moving the keyboard focus into it, shows its actions side by side at its top right, each an icon that names itself on hover: **Reply in thread** (top-level messages, for members who can post), **Start runtime from this message**, **Copy message as context** (**Copy thread as context** when the message has replies or is one), and, for its author only, **Edit** and **Delete**. An action a member cannot take is not shown. The actions are one stop for Tab; the left and right arrow keys, Home and End move between them. Runtime chats have no message actions.

## Threads

In a channel, the actions of a top-level message offer **Reply in thread**. Replies stay under their root message, collapsed behind a toggle such as "3 replies · 1 new"; they never appear in the channel flow. Replies are ordinary messages: their authors can edit or delete them, and a deleted root keeps its thread. Runtime chats have no threads, and the server refuses a reply there.

## Search

**Search** at the top of the sidebar, or the **/** key, searches the text of the messages of every chat the member can read in the workspace: the public channels and the chats they take part in. The server applies the same rule as for reading a chat, so a message of a private chat never reaches a member who is not in it, and deleted messages and agent steps are left out. The search ignores case, accented capitals included for a word written all lower case, capitalized or all upper case (été finds Été and ÉTÉ), and wildcard characters match only themselves. It lists the 30 newest matches, each with its chat, author, date and the matched text marked. The arrow keys move through the list and Enter (or a click) opens the chat, finding the searched text there. A match in a thread opens on the thread's root message. Chats that are archived are left out.

**Find in this chat**, in the chat header or the **F** key, highlights the searched text in the messages on screen, even across bold, links or code inside a paragraph, and counts the matches ("2 of 5"). It starts on the newest match; Enter or **Next match** moves down, Shift+Enter or **Previous match** moves up, and Escape closes it. It searches the messages loaded so far: **Search earlier messages** loads more. Opening a match from Search loads earlier messages until the matched one is on screen. The searched text stays in the browser and is never put in the address bar.

## Keyboard shortcuts

Single keys move around the workspace. They do nothing while typing in a field or while a dialog or menu is open (Escape leaves the composer), and **?** lists the ones available on the current page. A button's tooltip shows its shortcut after its name, for example "Collapse sidebar L" or "New chat C", as the side panel's tabs show "Files R then 1".

| Key | Action |
|---|---|
| **L** | Collapse or expand the left sidebar |
| **R** | Hide or show the side panel on the right |
| **R** then **1**, **2**… | Open the side panel on its first, second… tab |
| **B** | Browse channels |
| **C** | Create a chat |
| **P** | Create a project |
| **S** | Workspace settings (for members who can open them) |
| **Esc** | Back to Workspace settings from one of its pages |
| **I** | Profile |
| **/** | Search the workspace |
| **F** | Find in this chat |
| **?** | List the keyboard shortcuts |

## Unread state

A chat with messages a member has not seen shows an **Unread messages** icon in the sidebar. Opening the chat marks it read. In a runtime chat, the icon's color and tooltip tell where the agent is: **working** on a turn, **waiting** for an answer to a question or a tool approval, stopped with an **error**, or **done**. A channel's icon keeps the text color. In channels only top-level messages count: a new reply never makes the channel unread. Each thread keeps its own read marker per member; opening a thread marks it read, and its toggle shows how many replies are new.

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
- A tool call that is not read-only (the tool does not declare the MCP `readOnlyHint`) waits for the **owner's approval**, except Spyria's own `open_page` and `take_screenshot`, which use none of the owner's connections. The owner sees a **Tool approval** card with Approve and Deny; everyone else sees that it is waiting. Without an answer within 5 minutes the call expires. Deny, expiry or **Stop** answer the agent that the owner did not approve the call.
- Model calls always run on the **prompter's own key**, never the owner's (see [Agents](./agents.md)).

Every tool call is recorded with its prompter, owner and approval decision, and appears in the audit log.

## Forking a runtime chat

**Fork into my session** in a runtime chat's header creates a new runtime chat owned by the member who forked it, in the same project. Any participant who can read the chat can fork it; the owner sees the button too. The fork starts with one message that quotes the conversation so far (members' messages and the agent's replies, with their authors and times), and its header links back with "Forked from". A fork is the way to continue someone else's work with your own tools, machine or model. A fork of a dev chat continues on the original's branch; see [Dev mode](./dev-mode.md#forking-a-dev-chat).

Only runtime chats can be forked.

## Starting a runtime from a channel thread

In a channel, every message's actions include **Start runtime from this message**. It creates a runtime chat owned by the member who chose it, named from the message, and seeded with the whole thread (the root and its replies) as quoted context. The other authors of the thread who can read the channel join the new chat as Readers. The channel message shows a link to the runtime chat it started, and the runtime chat links back with "Started from".

This lets members discuss freely in a channel and bring an agent in only when there is work to do, without moving the conversation by hand.

**Copy thread as context** (**Copy message as context** for a message without replies) puts the thread in the clipboard instead, headed "Conversation from channel thread in #*channel*" and quoting each message with its author and time as a runtime's first message does, to paste into an agent elsewhere, such as a runtime chat already under way or a tool outside Spyria. The quote is built in the browser from the messages it shows, and the clipboard is the only place it goes.

## When a chat owner leaves the workspace

When an admin removes a member, that member's runtime chats are **frozen**: they show "This chat is frozen: its owner left the workspace", and nobody can prompt in them, because the agent would otherwise act with a departed member's identity. An admin can **Transfer** a frozen chat to an active member, who becomes its owner. Channels never freeze. See [Admin](./admin.md).

## Side panel

The side panel next to a chat has tabs that depend on the chat type. Runtime chats have **Files**, **Changes**, **Commits**, **Browser**, **Usage**, **Connected tools** and **Members**; channels have **Browser**, **Sources**, **Usage**, **Connected tools** and **Members**. **Usage** breaks down the chat's model spend per member and per model, and **Connected tools** lists the workspace and personal connections the agent can use. The dev tabs are described in [Dev mode](./dev-mode.md). **Sources** is a placeholder: nothing fills it yet. **R** collapses or expands the side panel, and **R** then a number opens it on that tab; each tab's tooltip shows its shortcut.

### Browser

**Browser** lists the pages the agent opens for the members of the chat by their address, newest first, and a page the agent opens while the tab is on screen shows at once. The agent opens a page with the `open_page` tool of Spyria's tool server, on a Spyria runtime or a member's machine alike: a public web address, or a file of the project such as an HTML report it built.

A page the agent opens is not loaded until the member asks: it shows as a card with its full address and a **Load page** button, the same rule as remote images in messages. The address is the page's name everywhere in the tab; the title the agent gives it only shows under the address in the list. The server refuses an `open_page` address on the member's own machine or network, and tells the agent why: `localhost`, loopback, private and link-local addresses, `.local` names and names without a dot. Otherwise an instruction hidden in a web page or file the agent reads could make the browser of every member viewing the chat reach their own machine or network.

The bar at the top takes an address or a search: an address the member types loads at once, as it is (`example.com` opens over https, `localhost` over http), and other text is searched for with Bing. **All pages** goes back to the list, and **Open in a new tab** opens a web page outside Spyria, for sites that refuse to be shown inside another page. Pages are sandboxed: a web page runs without access to Spyria, and an HTML file of the project runs its scripts in an isolated frame. The pages a member browses are not saved or shared; the pages the agent opens are.

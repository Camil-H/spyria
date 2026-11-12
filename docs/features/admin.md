# Administration

This page covers what workspace admins manage: members and invites, workspace and chat roles, sign-in, GitHub, shared tools, spend, budgets and the audit log, and deleting the workspace. It describes the features as admins and members see them; deployment steps (the sign-in providers, the GitHub App) are in [Manual install](../guides/self-hosting.md).

Everything here is in **Workspace settings** (the workspace menu), as cards in three sections; Escape goes back from a card's page to the cards. A member sees only the cards their workspace role allows, and the server checks the same permission on every request, so hiding a card is a convenience, not the protection.

| Section | Card | Permission needed |
|---|---|---|
| Setup your organization | **Setup SSO** | `sso.manage` |
| | **Connect GitHub** | `github.manage` |
| | **Roles and Permissions** | `roles.manage` |
| | **Manage Team** | `members.invite` or `members.manage` |
| Setup your agents | **Connect runtime** | `runtimes.manage` |
| | **AI providers** | `providers.manage` |
| | **Tools** | `tools.manage` |
| | **Quality gates** | `github.manage` |
| Analyze usage | **Analyze costs** | `costs.view` or `budgets.manage` |
| | **Audit log** | `audit.view` |

## Setup checklist

Until the workspace is set up, the top of the sidebar shows **Get started** with how many tasks are done and the next one; it opens that task's page. **Workspace settings** lists the workspace tasks at the top (**Get your workspace ready**) and **Profile** the personal ones (**Set up your profile**). Each list can be collapsed, which the browser remembers.

| Task | Who sees it | Done once |
|---|---|---|
| Connect the GitHub App | `github.manage` | the workspace has a GitHub App |
| Connect a runtime | `runtimes.manage` | a workspace runtime host has been claimed |
| Add your AI key | every member | they have an LLM key in the workspace |
| Invite members | `members.invite` | there is a pending invite or another member |
| Link your GitHub account | every member, once the workspace has had a GitHub App | they linked their GitHub account |
| Add a profile picture | every member | they have a picture |

Workspace tasks are shared: done by one admin, done for all. A task stays done even if what completed it is undone later (the GitHub App removed, the last key deleted); the cards show the current state. Anyone can **Skip** a task they see: it leaves their lists and their count, for them only. A done task leaves the list and only counts in its "x of y done"; a list disappears once all its tasks are done, and the sidebar entry once all of the member's are.

## Workspace roles

A workspace role is a named set of permissions. Two are built in and cannot be changed: **Admin** has every permission, **Member** has none. With `roles.manage` you can create custom workspace roles from these permissions:

| Permission | Shown as |
|---|---|
| `members.invite` | Invite members |
| `members.manage` | Change roles and remove members |
| `roles.manage` | Manage roles |
| `sso.manage` | Set up SSO |
| `github.manage` | Connect GitHub |
| `tools.manage` | Manage the tools catalogue |
| `providers.manage` | Manage AI providers |
| `runtimes.manage` | Manage runtime hosts and local sessions |
| `costs.view` | View costs |
| `budgets.manage` | Manage budgets |
| `audit.view` | View the audit log |

Rules that hold whatever the role:

- You can only give a role whose permissions you hold yourself, and only change or remove a member whose role you could give.
- Nobody changes their own role or removes themselves.
- A workspace always keeps at least one Admin, even when two admins demote each other at the same moment.
- A role name has 1 to 40 characters, is unique in the workspace (ignoring case) and cannot reuse a built-in name.
- A custom role held by a member or a pending invite cannot be deleted until they are given another role. Editing a role applies at once to everyone holding it.

Role changes apply live: no new sign-in is needed.

## Chat roles

Every chat gives each participant a chat role, which decides what they can do in that chat (see [Chats and sharing](./chats-and-sharing.md)). **Roles and Permissions** has a second tab, **Chat roles**, with the four built-in roles and any custom ones:

| Permission | Shown as | Owner | Editor | Prompter | Reader |
|---|---|---|---|---|---|
| `chat.read` | Read the chat | yes | yes | yes | yes |
| `chat.post` | Post and prompt the agent | yes | yes | yes | |
| `session.configure` | Choose the model and stop the agent | yes | yes | | |
| `tools.manage` | Manage the chat's tools | yes | | | |
| `members.invite` | Invite people to the chat | yes | yes | | |
| `members.manage` | Change roles and remove people | yes | | | |
| `chat.admin` | Rename, move and archive the chat, change its visibility | yes | | | |

A custom chat role always includes `chat.read`. It can be given in a chat only by someone who holds all its permissions there, never replaces Owner, and on a public channel only when it includes posting (everyone in the workspace can already read and post there). Deleting a chat role still held in a chat is refused with the number of members and chats holding it.

## Members and invites

**Manage Team** lists the members with their workspace role, the pending invites, and an **Invite** form (email and role).

- Inviting is an allow-list of exact addresses: no account is created and no email is sent, so tell the person yourself. An invite works at once. The invited person signs in at that address, with their own account or, when the workspace enforces SSO, through its provider; their first sign-in accepts every open invite for that address. Nobody joins a workspace any other way.
- An invite expires after 7 days and can be revoked. There is one pending invite per address; inviting a current member is refused. Email addresses are compared without regard to case.
- Someone who signs in with an account but has no membership or open invite can create a workspace of their own, or ask an Admin to invite their address.
- A signed-in member whose workspace takes more than 10 seconds to load, for example right after a deploy or while the connection is down, sees that it is taking longer than usual, with a **Try again** button; the app keeps trying and opens as soon as the workspace arrives, rather than sending them back to sign in. If their session ends meanwhile, the sign-in screen says so.

### Removing a member

**Remove** takes effect at once:

- the member's sessions in that workspace end and their open agent streams close;
- their own machine is removed from the workspace, their API keys and their sign-ins to tool servers are deleted, and their linked GitHub account is forgotten;
- they leave every chat they did not own; their name stays on past messages.

Runtime chats they owned **freeze**: participants can still read them, but nobody can prompt ("This chat is frozen: its owner left the workspace"), and their runtimes stop. A frozen chat cannot act on the departed owner's rights, which is why it stops rather than continuing under someone else. A member with `members.manage` can pick a new owner with **Transfer to** in the chat; the new owner becomes its Owner and the chat thaws. Only a chat whose owner has left can be transferred. Channels never freeze, since no agent acts with their owner's rights; they can still be transferred.

Inviting a removed member's address again creates a normal invite that restores their membership when they sign in.

## Sign-in and SSO

People sign in with an account at a provider the deployment offers (Google, Microsoft or another OIDC provider, set by the operator); there are no passwords. **Setup SSO** lets a workspace enforce its organization's own provider instead, so that people lose access when their organization account is removed. The rules and the sign-in screen are in [who can join and sign-in](../guides/who-can-join.md); the reasoning is in [decision 0029](../decisions/0029-account-sign-in-and-workspace-sso.md).

The card offers Google Workspace (only accounts managed by the Google Workspace of their address's domain, and Gmail addresses), Microsoft Entra (one tenant, from its tenant id) or another OIDC provider, with a client id and a client secret that is sealed, shown only as set and replaced by entering a new one. When the deployment has its own Google or Microsoft app, Google Workspace and Microsoft Entra can use it instead: no client id or secret to enter (Microsoft still asks for the tenant id). Saving checks the issuer's discovery document. On a development deployment the card says sign-in uses the deployment's Dex instead.

- **Enforce SSO** opens the provider's sign-in: you confirm by signing in through it with your own address, and nothing changes if that does not complete. From then on only that provider opens the workspace, for everyone, Admins included.
- **Save and sign in again** changes the provider the same way. A new provider (another issuer or tenant) signs everyone out of the workspace; members sign in again through it, matched once by the address they were invited at. A new client or secret for the same provider keeps everyone signed in.
- **Stop enforcing SSO** signs everyone out of the workspace, you included; they then sign in with their own accounts. It is refused when the deployment offers no account provider.

A session opened through a workspace's own provider opens only that workspace: it cannot list or open the person's other workspaces, or create one.

## GitHub

**Connect GitHub** creates the workspace's GitHub App on GitHub in one click (on your account or an organization), or takes the details of an App created by hand. It then lists the repositories the App's installations grant. How dev chats use it is described in [Dev mode](./dev-mode.md); the setup steps are in [Manual install](../guides/self-hosting.md).

## Runtime hosts and members' machines

**Connect runtime** lists the workspace's runtime hosts, adds new ones, and, in its **Member local runtimes** section, holds the switch **Members can run sessions on their own machine**. Turning it off stops members from adding a machine or starting a chat on one, and prompts in existing ones get a notice. See [Machines](./machines.md).

Its **Setup commands** set what a dev chat's runtime runs when it starts, before the agent gets a message: a **Default setup command** tab for the repositories without one of their own, a tab for each repository that has its own, and a **New repository setup command** tab to add one, as the quality gates do. Nothing runs without one, even a repository's `.spyria/setup.sh`. Every member can read them, so they hold no secret. See [Dev mode](./dev-mode.md#clone-and-setup-script).

## Quality gates

**Quality gates** sets the gates the work of dev chat agents goes through before it reaches the owner: the **Default rules**, and rules for each repository that needs its own, each with its own switch, its gates and the limits of a run (time and cost). Gates run in order (commands, a code review, the pull request, CI), each saying whether a failure goes back to the agent, and how many times, or hands over to the owner. Repositories are listed once GitHub is connected. See [Dev mode](./dev-mode.md#quality-gates).

## Tools

**Tools** is the workspace's catalogue of approved tool servers (MCP). Each server has a name, unique in the workspace, its address, and how members sign in, chosen when it is added:

- **Each member signs in** (the default): each member connects their own account in **Profile** > **Tool connections**, and Spyria uses it on their chats. Adding the server opens a window where you sign in once with your own account: the gateway uses that sign-in only to list the server's tools, and the server is ready once you have. If the sign-in fails, Spyria removes the server and says why; while it waits, the server reads "Waiting for the sign-in that lists its tools", and one whose window was closed before the end stays so until it is removed. Its address cannot change once added, since members' sign-ins belong to it: remove it and add it again. The server must let the gateway register itself (OAuth dynamic client registration); one that needs a pre-registered OAuth app, such as GitHub's MCP server, cannot be added yet.
- **One shared login**: every member's calls use a secret header (name and value) you enter, only for servers without their own sign-in, such as API-key or internal servers. The secret is stored in the model gateway only, never in Spyria's database, and is never shown again. Changing the address or the header recreates the server in the gateway.

Members cannot add servers of their own. Once a server is added, its card shows how many tools it has and how many read or write ("12 tools · 8 read · 4 write"):

- **What each tool does**: Spyria marks each tool as only reading or writing from what the server says, and you confirm or correct each marking, in a searchable list grouped into read and write tools, then click **Confirm**. Nobody gets the server until you do. **Correct read and write** changes the markings later; tools a new listing adds count as writing until you mark them. Tools the server marks destructive say so.
- **Access**: each workspace role has a level on the server, **None** (the default), **Read** (the tools marked read) or **Read and write**. **Single tools** opens the same searchable list for that role, with a switch to allow all read or all write tools and a checkbox per tool, to allow or refuse one tool against the level. **Add a member** names a member on the server with their own level and single tools, which replace their role's there, to give them more or less; **Remove** returns them to their role's. A member with no tool of a server does not see it.

Each member's gateway key is given exactly the tools their access gives on each server, and the gateway enforces it on every call. Changing a member's role gives them the new role's tools at once. Servers of one workspace are invisible to other workspaces. Adding, changing or removing a server reaches agents that are already running, in every chat: Spyria tells each of them that its tools changed, and Pi lists them again without a restart (Claude Code and Codex on a member's machine do so only if they support that notice). Removing a server also deletes every member's sign-in to it.

When an agent acts, it uses the chat owner's access. On a guest's prompt it uses only the shared-login servers, with what both the owner and the guest may use, never a server the owner signed in to with their own account. Which calls wait for the owner's approval is each member's choice in their profile (see [Agents](./agents.md#tool-approvals)). See [decision 0030](../decisions/0030-workspace-tools-catalogue.md) and [decision 0031](../decisions/0031-tool-access-levels-and-approvals.md).

## AI providers

**AI providers** chooses which model providers members can use. By default every provider is allowed. Turning a provider off turns the setting into an allow-list of providers; a provider that is on allows all its models:

- a member cannot add a key for a provider that is off ("OpenAI is not allowed in this workspace");
- the models of a provider that is off are not offered in the model picker, nor chosen by routing or for sub-agents;
- the model relay refuses a call to such a model before it reaches the gateway, and the chat shows "*Model* is not allowed in this workspace".

**Allow every provider** removes the allow-list. Keys already added for a provider turned off stay in the member's profile but reach no model. Sessions on a member's own machine (Claude Code, Codex) use the member's own subscription and are not covered. Each change is recorded in the audit log.

The page lists the providers in two groups: labs (Anthropic, OpenAI, Google Gemini, Mistral, xAI, DeepSeek, Z.ai, Meta and TypeSafe, whose decision models route turns) and routers (OpenRouter), listed once in `packages/kernel/src/models.ts`. Meta is reached through the OpenAI-compatible Meta Model API (`api.meta.ai`), with Muse Wonder as its large model and Muse Spark as its medium one.

## Spend

**Analyze costs** reports the cost of model calls made through the gateway, for a period (this month, last month, last 30 or 90 days, or custom up to a year) at a day, week or month granularity:

- spend over time, stacked by member, project or model;
- tables per member, project, chat and model with cost, tokens, requests and share;
- a breakdown of spend into users × sessions per user × turns per session × requests per turn × tokens per request × price per token, compared with the previous period of the same length, with the factor that moved spend the most highlighted;
- clicking a factor or the total spend opens a line chart of it per day, week or month under its row, and clicking it again closes it;
- **For** narrows the breakdown and its charts to one member, project, chat or model (the tables and the spend chart stay whole);
- the cost per merged pull request, with the list of those pull requests.

Calls delegated to sub-agents count in the turn that delegated them. Every member sees their own figures in **Profile** > **My usage**, and never anyone else's. Sessions on a member's own Claude or ChatGPT subscription are not metered by Spyria and do not appear.

## Budgets

On the same page, a member with `budgets.manage` sets an optional monthly budget in dollars per member and an optional monthly total for the workspace. Months are calendar months in UTC.

- **Alerts** at 80% and 100%, once per threshold per month: the member sees a banner in **My usage** and a notice above the composer; admins see a badge on the **Analyze costs** card and the list of members above 80%.
- **Hard stop** at 100%: the member's model calls are refused before reaching the provider, including the calls of their running sub-agents and the routing call of their next turn. The chat shows "<Name>'s monthly AI budget is used up; a member with the Manage budgets permission can raise it in Workspace settings". Once the workspace total is reached, every member is refused with the workspace's wording.
- Raising or removing the budget lets the member prompt again at once.

Spend is counted from the gateway's usage records, which Spyria reads every few seconds, and a call is priced only after it ran. A budget can therefore be exceeded by the calls of the last few seconds, typically cents.

## Deleting the workspace

At the bottom of **Workspace settings**, an Admin finds **Delete workspace**. It is not a card and no workspace role can grant it: only members with the built-in Admin role see it, and the server checks the same. The dialog lists what goes and asks to type `DELETE`.

- At once, every member loses access: their sessions end, their open agent streams close, running runtimes stop, and the workspace's background work, GitHub webhooks, agents' and sub-agents' model calls are refused. A few minutes later, runtimes that were still starting are removed, so a restored workspace starts those afresh. The workspace disappears from everyone's workspace switcher.
- Seven days later, Spyria erases the workspace for good: chats and their whole history, runtimes with their containers and files on the hosts, members' model keys in the gateway, the tools catalogue, the link to the GitHub App, the sign-in settings, the audit log, and the people who belonged to no other workspace and never signed in with an account of their own.
- The GitHub App stays installed on the organization: uninstall it on GitHub.
- Until the seven days are over, only the operator can restore the workspace ([Manual install](../guides/self-hosting.md#deleting-a-workspace)).
- When the only workspace of a deployment is erased, creating one needs the setup link again ([who can join and sign-in](../guides/who-can-join.md)).

## Audit log

**Audit log** shows, newest first, who changed what in the workspace: time, person (a member; "Alice's agent" for what an agent did in Alice's turn; "System" for a job, with the member it acted for when there is one; "GitHub" for pull request changes from GitHub), action in plain words, target, and details on expand. It merges:

| Group | Records |
|---|---|
| Members | invites, revoked invites, joins, role changes, removals |
| Workspace | workspace deleted, restored by the operator, AI providers allow-list changed, quality gates changed, setup commands changed |
| Sign-in | SSO configured, client secret replaced |
| GitHub | App configured, App secrets replaced |
| Tools | tool servers added, changed, removed, reviewed, and changes to who may use them |

| Chats | chat members added, removed, leaving, role changes, visibility changes, transfers, chats started from another chat, deleted messages with their text |
| Tool calls | every agent tool call, with prompter, owner, server, tool, whether it writes, approval decision and outcome |
| Publishing | pushes, pull requests opened, reopened, turned into drafts, merged, closed |
| Budgets | budget changes, thresholds reached |
| Roles | custom chat and workspace roles created, changed, deleted |

The log records metadata only, with one exception: a **Deleted a message** record shows the text the message had when it was deleted, in any chat, private ones included, since that text is no longer shown in the chat itself. It never shows the body of a message that is still in a chat. Filter by person (which also lists what was done on their behalf), group and date range; **Export CSV** downloads the filtered records.

**Keep audit records** is Forever by default, or a number of days (1 to 36,500). A daily job deletes workspace events, tool call records and the texts of deleted messages older than that. Chat events are the conversation history itself and are deleted only with the workspace; past the retention they only drop out of the audit view. Changing the retention is itself recorded.

Related: [Security](../architecture/security.md), [Operations](../guides/operations.md).

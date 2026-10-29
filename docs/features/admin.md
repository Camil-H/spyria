# Administration

This page covers what workspace admins manage: members and invites, workspace and chat roles, sign-in, GitHub, shared tools, spend, budgets and the audit log, and deleting the workspace. It describes the features as admins and members see them; deployment steps (SMTP, the identity provider, the GitHub App) are in [Self-hosting](../guides/self-hosting.md).

Everything here is in **Workspace settings** (the workspace menu), as cards in three sections. A member sees only the cards their workspace role allows, and the server checks the same permission on every request, so hiding a card is a convenience, not the protection.

| Section | Card | Permission needed |
|---|---|---|
| Setup your organization | **Setup SSO** | `sso.manage` |
| | **Connect GitHub** | `github.manage` |
| | **Roles and Permissions** | `roles.manage` |
| | **Manage Team** | `members.invite` or `members.manage` |
| Setup your agents | **Connect runtime** | `runtimes.manage` |
| | **MCP tools** | `tools.manage` |
| Analyze usage | **Analyze costs** | `costs.view` or `budgets.manage` |
| | **Audit log** | `audit.view` |

## Setup checklist

Until the workspace is set up, the top of the sidebar shows **Get started** with how many tasks are done and the next one; it opens that task's page. **Workspace settings** lists the workspace tasks at the top (**Get your workspace ready**) and **Profile** the personal ones (**Set up your profile**). Each list can be collapsed, which the browser remembers.

| Task | Who sees it | Done once |
|---|---|---|
| Verify your email domain | `sso.manage`, on SSO deployments | the domain is verified |
| Connect the GitHub App | `github.manage` | the workspace has a GitHub App |
| Connect a runtime | `runtimes.manage` | a workspace runtime host has been claimed |
| Add your AI key | every member | they have an LLM key in the workspace |
| Invite members | `members.invite` | there is a pending invite or another member |
| Link your GitHub account | every member, once the workspace has had a GitHub App | they linked their GitHub account |
| Add a profile picture | every member | they have a picture |

Workspace tasks are shared: done by one admin, done for all. A task stays done even if what completed it is undone later (the GitHub App removed, the last key deleted); the cards show the current state. On SSO deployments, **Invite members** stays greyed out until the domain is verified. Anyone can **Skip** a task they see: it leaves their lists and their count, for them only. A list disappears once all its remaining tasks are done, and the sidebar entry once all of the member's are.

## Workspace roles

A workspace role is a named set of permissions. Two are built in and cannot be changed: **Admin** has every permission, **Member** has none. With `roles.manage` you can create custom workspace roles from these permissions:

| Permission | Shown as |
|---|---|
| `members.invite` | Invite members |
| `members.manage` | Change roles and remove members |
| `roles.manage` | Manage roles |
| `sso.manage` | Set up SSO |
| `github.manage` | Connect GitHub |
| `tools.manage` | Manage shared MCP tools |
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

- Inviting is an allow-list: no account is created and no email is sent, so tell the person yourself. The invited person signs in with their work email through the workspace's provider; their first sign-in accepts every open invite for that address.
- An invite expires after 7 days and can be revoked. There is one pending invite per address; inviting a current member is refused. Email addresses are compared without regard to case.
- In SSO mode, invites open only once the workspace's email domain is verified (see below), so nobody new gets in before the admin has proven they control the domain.
- Someone who signs in without a membership or an open invite sees that no workspace has invited them.
- If a sign-in succeeds but the workspace does not load within 30 seconds, the sign-in screen says so and asks to sign in again, instead of waiting without end.

### Removing a member

**Remove** takes effect at once:

- the member's sessions in that workspace end and their open agent streams close;
- their own machine is removed from the workspace, their API keys and their personal tool connections are deleted, and their linked GitHub account is forgotten;
- they leave every chat they did not own; their name stays on past messages.

Runtime chats they owned **freeze**: participants can still read them, but nobody can prompt ("This chat is frozen: its owner left the workspace"), and their runtimes stop. A frozen chat cannot act on the departed owner's rights, which is why it stops rather than continuing under someone else. A member with `members.manage` can pick a new owner with **Transfer to** in the chat; the new owner becomes its Owner and the chat thaws. Only a chat whose owner has left can be transferred. Channels never freeze, since no agent acts with their owner's rights; they can still be transferred.

Inviting a removed member's address again creates a normal invite that restores their membership when they sign in.

## Sign-in and domain verification

Production deployments sign in through each workspace's own OpenID Connect provider; there is no shared account system. See the decision records in [decisions](../decisions/) and [Security](../architecture/security.md) for the reasoning.

**Setup SSO** holds the provider: Google Workspace, Microsoft Entra (a tenant-specific issuer, from its tenant id) or another OIDC issuer, with the client id and a client secret that is sealed, shown only as set and replaced by entering a new one. When the deployment has its own Google or Microsoft app, those providers can use it instead: no client id or secret to enter (Microsoft still asks for the tenant id), **Use your own app** switches back to entering a client. Through Google, whichever app, only verified addresses of accounts managed by the domain's Google Workspace sign in. Through Microsoft, a person is recognized by their Entra object id, and guests from other tenants are never matched to a member or an invite by email. Changing the issuer (another provider, another Microsoft tenant or another OIDC issuer) unverifies the domain, and members cannot sign in until it is verified again; changing the client, or switching between your own app and the deployment's, keeps it verified. Saving checks the issuer's discovery document. The workspace's email domain is set when the workspace is created and cannot be changed. On a development deployment the card says sign-in uses the deployment's Dex instead.

The sign-in screen asks for a work email and routes its domain to the provider of the workspace using it, so it never reveals who is a member. A domain routes sign-in, and the workspace can invite, only once the domain is **verified**:

1. The admin enters any address at the domain; Spyria emails it a single-use link valid for 24 hours.
2. Opening the link, without signing in, verifies the domain for that workspace.

Until then the card shows the domain as not verified or pending. Two workspaces may share a domain only if they use the same provider; a different provider for a domain already claimed is refused. While a deployment has a single workspace, its own unverified domain still routes sign-in, so its first admin can sign back in before verifying; invites stay closed until verification. The first workspace of a deployment is created from the sign-in page; see [Self-hosting](../guides/self-hosting.md).

Accounts are matched on the provider's issuer and subject, not the email, so a changed address at the provider keeps the same Spyria account.

## GitHub

**Connect GitHub** creates the workspace's GitHub App on GitHub in one click (on your account or an organization), or takes the details of an App created by hand. It then lists the repositories the App's installations grant. How dev chats use it is described in [Dev mode](./dev-mode.md); the setup steps are in [Self-hosting](../guides/self-hosting.md).

## Runtime hosts and members' machines

**Connect runtime** lists the workspace's runtime hosts, adds new ones, and holds the switch **Members can run sessions on their own machine**. Turning it off stops members from adding a machine or starting a chat on one, and prompts in existing ones get a notice. See [Machines](./machines.md).

## Shared tools

**MCP tools** registers tool servers (MCP) for the whole workspace: a display name, the server's URL and an optional secret header (name and value). The secret is stored in the model gateway only, never in Spyria's database, and is never shown again. Changing the URL or the header recreates the connection in the gateway.

After registration, Spyria lists the server's tools, each marked read-only or writes:

- **Allowed tools** decides which of them the workspace may use (all by default).
- **Member access** narrows them per member: all allowed tools, some, or none.

Each member's gateway key is given exactly the workspace's connections with the allowed tools minus their restrictions, and the gateway enforces it on every call. Connections of one workspace are invisible to other workspaces. Removing a connection takes its tools away from agents at once, in every chat. Members see what they may use in **Profile** > **Connections** > **Shared with me**.

When an agent acts, it uses the chat owner's access. On a guest's prompt it uses only what both the owner and the guest may use on shared connections, never the owner's personal connections, and write calls wait for the owner's approval (see [Agents](./agents.md)).

## Spend

**Analyze costs** reports the cost of model calls made through the gateway, for a period (this month, last month, last 30 or 90 days, or custom up to a year) at a day, week or month granularity:

- spend over time, stacked by member, project or model;
- tables per member, project, chat and model with cost, tokens, requests and share;
- a breakdown of spend into users × sessions per user × turns per session × requests per turn × tokens per request × price per token, compared with the previous period of the same length, with the factor that moved spend the most highlighted;
- the cost per merged pull request, with the list of those pull requests.

Calls delegated to sub-agents count in the turn that delegated them. Every member sees their own figures in **Profile** > **My usage**, and never anyone else's. Sessions on a member's own Claude or ChatGPT subscription are not metered by Spyria and do not appear.

## Budgets

On the same page, a member with `budgets.manage` sets an optional monthly budget in dollars per member and an optional monthly total for the workspace. Months are calendar months in UTC.

- **Alerts** at 80% and 100%, once per threshold per month: the member sees a banner in **My usage** and a notice above the composer; admins see a badge on the **Analyze costs** card and the list of members above 80%.
- **Hard stop** at 100%: the member's model calls are refused before reaching the provider, including the calls of their running sub-agents and the routing call of their next turn. The chat shows "<Name>'s monthly AI budget is used up; an admin can raise it in Workspace settings". Once the workspace total is reached, every member is refused with the workspace's wording.
- Raising or removing the budget lets the member prompt again at once.

Spend is counted from the gateway's usage records, which Spyria reads every few seconds, and a call is priced only after it ran. A budget can therefore be exceeded by the calls of the last few seconds, typically cents.

## Deleting the workspace

At the bottom of **Workspace settings**, an Admin finds **Delete workspace**. It is not a card and no workspace role can grant it: only members with the built-in Admin role see it, and the server checks the same. The dialog lists what goes and asks to type `DELETE`.

- At once, every member loses access: their sessions end, their open agent streams close, running runtimes stop, and the workspace's background work, GitHub webhooks, agents' and sub-agents' model calls are refused. A few minutes later, runtimes that were still starting are removed, so a restored workspace starts those afresh. The workspace disappears from everyone's workspace switcher.
- Seven days later, Spyria erases the workspace for good: chats and their whole history, runtimes with their containers and files on the hosts, members' model keys in the gateway, shared connections, the link to the GitHub App, the sign-in settings and the email domain, the audit log, and the accounts of people who belonged to no other workspace.
- The GitHub App stays installed on the organization: uninstall it on GitHub.
- Until the seven days are over, only the operator can restore the workspace ([Self-hosting](../guides/self-hosting.md#deleting-a-workspace)).
- When the only workspace of a deployment is erased, its domain is free again and the sign-in page offers **Create a workspace**.

## Audit log

**Audit log** shows, newest first, who changed what in the workspace: time, person ("System" when no member acted), action in plain words, target, and details on expand. It merges:

| Group | Records |
|---|---|
| Members | invites, revoked invites, joins, role changes, removals |
| Workspace | workspace deleted, restored by the operator |
| Sign-in | SSO configured, client secret replaced, domain verified |
| GitHub | App configured, App secrets replaced |
| Connections | shared connections added, changed, removed, member restrictions |
| Chats | chat members added, removed, leaving, role changes, visibility changes, transfers, chats started from another chat, deleted messages with their text |
| Tool calls | every agent tool call, with prompter, owner, server, tool, whether it writes, approval decision and outcome |
| Publishing | pushes, pull requests opened, reopened, turned into drafts, merged, closed |
| Budgets | budget changes, thresholds reached |
| Roles | custom chat and workspace roles created, changed, deleted |

The log records metadata only, with one exception: a **Deleted a message** record shows the text the message had when it was deleted, in any chat, private ones included, since that text is no longer shown in the chat itself. It never shows the body of a message that is still in a chat. Filter by person, group and date range; **Export CSV** downloads the filtered records.

**Keep audit records** is Forever by default, or a number of days (1 to 36,500). A daily job deletes workspace events, tool call records and the texts of deleted messages older than that. Chat events are the conversation history itself and are deleted only with the workspace; past the retention they only drop out of the audit view. Changing the retention is itself recorded.

Related: [Security](../architecture/security.md), [Operations](../guides/operations.md).

# Administration

What workspace admins manage: members, roles, sign-in, GitHub, tools, spend, budgets, the audit log and deleting the workspace. The account providers people sign in with are set by your operator for the whole Spyria ([Operations](../guides/operations.md#account-providers)); everything else is here.

Everything is in **Workspace settings** (the workspace menu), as cards showing their state. Each page lists items as rows with a **⋯** menu and keeps risky actions at the bottom; Escape goes back to the cards. A member sees only the cards their role allows, and the server checks the same permission on every request.

| Section | Card | Permission needed |
|---|---|---|
| Organization | **Single sign-on** | Set up SSO |
| | **GitHub** | Connect GitHub |
| | **Members and roles** | Invite members, Change roles and remove members, or Manage roles |
| Agents | **Runtimes** | Manage runtime hosts and local sessions |
| | **AI providers** | Manage AI providers |
| | **Tools** | Manage the tools catalogue |
| | **Browser** | Manage the tools catalogue |
| | **Quality gates** | Connect GitHub |
| Usage | **Costs and AI budgets** | View costs or Manage budgets |
| | **Audit log** | View the audit log |

## Setup checklist

Until the workspace is set up, the top of the sidebar shows **Get started** with how many tasks are done and the next one; it opens that task's page.

- Workspace tasks are at the top of **Workspace settings** (**Get your workspace ready**), personal ones in **Profile** (**Set up your profile**). Lists can be collapsed.
- **Profile** has cards **Account**, **LLM keys**, **My machine**, **Connections** and **Usage** (the member's spend this month).
- **Profile** sets the app's appearance next to the member's name: **Light**, **Dark** or **System** (follows the device). The choice is kept in this browser.

| Task | Who sees it | Done once |
|---|---|---|
| Connect the GitHub App | Connect GitHub | the workspace has a GitHub App |
| Connect a runtime | Manage runtime hosts and local sessions | a workspace runtime host has been claimed |
| Add your AI key | every member | they have an LLM key in the workspace |
| Invite members | Invite members | there is a pending invite or another member |
| Link your GitHub account | every member, once the workspace has had a GitHub App | they linked their GitHub account |
| Add a profile picture | every member | they have a picture |

Good to know:

- Workspace tasks are shared: done by one admin, done for all.
- A task stays done even if later undone (App removed, last key deleted); the cards show the current state.
- **Skip** hides a task for you only.
- A list disappears once its tasks are done; the sidebar entry once all of yours are.

## Workspace roles

**Members and roles** has a **Members** tab and, with **Manage roles**, a **Roles** tab: a grid of permissions by role, switching between **Workspace roles** and **Chat roles**. Use **New role**, or **Edit** and **Delete** in a custom role's column menu.

A workspace role is a named set of permissions. The built-in **Admin** (every permission) and **Member** (none) cannot be changed. With **Manage roles** you can create custom roles from these permissions:

- Invite members
- Change roles and remove members
- Manage roles
- Set up SSO
- Connect GitHub
- Manage the tools catalogue
- Manage AI providers
- Manage runtime hosts and local sessions
- View costs
- Manage budgets
- View the audit log
- Change how long audit records are kept

Rules for every role:

- You can only give a role whose permissions you hold, and only change or remove a member whose role you could give.
- Nobody changes their own role or removes themselves.
- A workspace always keeps at least one Admin, even when two admins demote each other at the same moment.
- A role name has 1 to 40 characters, is unique in the workspace (ignoring case) and cannot reuse a built-in name.
- A custom role held by a member or a pending invite cannot be deleted until they get another role.
- Editing a role applies at once to everyone holding it. Role changes apply live, with no new sign-in.

## Chat roles

Each chat participant has a chat role that decides what they can do in that chat (see [Chats and sharing](./chats-and-sharing.md)). **Chat roles** lists the four built-in roles and any custom ones:

| Permission | Owner | Editor | Prompter | Reader |
|---|---|---|---|---|
| Read the chat | yes | yes | yes | yes |
| Post and prompt the agent | yes | yes | yes | |
| Choose the model and stop the agent | yes | yes | | |
| Manage the chat's tools | yes | | | |
| Invite people to the chat | yes | yes | | |
| Change roles and remove people | yes | | | |
| Rename, move and archive the chat, change its visibility | yes | | | |

A custom chat role:

- always includes **Read the chat**;
- can be given in a chat only by someone who holds all its permissions there;
- never replaces Owner;
- on a public channel, can be given only when it includes posting (everyone in the workspace can already read and post there).

Deleting a chat role still held in a chat is refused, with the number of members and chats holding it.

## Members and invites

The **Members** tab lists members (with **Sign out everywhere** and **Remove from workspace** in each row's menu), then pending invites with **Revoke**. **Invite member** asks for an email and a role. Each action confirms in a toast that fades after 5 seconds.

How invites work:

- An invite is an allow-list entry for an exact address. No account is created and no email is sent: tell the person yourself.
- It works at once. The person signs in at that address with their own account, or through the workspace's provider when it enforces SSO. Their first sign-in accepts every open invite for that address. Nobody joins a workspace any other way.
- An invite expires after 7 days and can be revoked. One pending invite per address; inviting a current member is refused. Addresses are compared without regard to case.
- Someone signed in with no membership or open invite can create their own workspace, or ask an Admin to invite their address.

Good to know: a workspace that takes over 10 seconds to load (after a deploy, or offline) shows that it is taking longer than usual, with **Try again**; the app keeps trying rather than sending the member to sign in.

### Removing a member

**Remove from workspace** takes effect at once:

- their sessions in the workspace end and their open agent streams close;
- their own machine is removed from the workspace, their API keys and tool-server sign-ins are deleted, and their linked GitHub account is forgotten;
- they leave every chat they did not own; their name stays on past messages.

Runtime chats they owned **freeze**:

- Participants can still read them, but nobody can prompt ("This chat is frozen: its owner left the workspace"), and their runtimes stop.
- A member with **Change roles and remove members** picks a new owner with **Transfer to** in the chat, which thaws it. Only a chat whose owner has left can be transferred.
- Channels never freeze, but can still be transferred.

Inviting a removed member's address again creates a normal invite that restores their membership when they sign in.

### Signing a member out

**Sign out everywhere** in a member's row menu (for example after a lost laptop) ends every session of that member in the workspace and closes their open agent streams.

- They stay a member and sign in again through their provider; a session in another workspace cannot reopen this one.
- After a lost device, also end their session at the provider, or it signs them in again.
- Needs **Change roles and remove members** and a member whose role you could grant. Recorded in the audit log under **Members**.
- Members sign themselves out from **Profile** > **Account** > **Sessions**, which lists where they are signed in.

## Sign-in and SSO

People sign in with an account at a provider the deployment offers (Google, Microsoft or another OIDC provider, set by the operator); there are no passwords. **Single sign-on** lets a workspace enforce its organization's own provider, so people lose access when their organization account is removed. Rules and the sign-in screen: [who can join and sign-in](../guides/who-can-join.md).

The page shows whether SSO is enforced, then the provider form. While none is enforced and you signed in with Google, a Microsoft work account or the deployment's OIDC provider, it is pre-filled: "Enforce *that provider* for this workspace", one **Enforce SSO** button, and **Use another provider** for the full form.

- **Google Workspace**: only accounts managed by the Google Workspace of their address's domain, and Gmail addresses.
- **Microsoft Entra**: one tenant, from its tenant id.
- **Another OIDC provider**.
- Each takes a client id and a client secret (stored encrypted, shown only as set, replaced by entering a new one).
- When the deployment has its own Google, Microsoft or OIDC app, that provider can use it with no client id or secret (Microsoft still asks for the tenant id).
- With your own app, the form shows the redirect URI to register at the provider, with a copy button, and what to create there.
- Saving checks the issuer's discovery document.

Actions:

- **Enforce SSO**: you confirm by signing in through the provider with your own address; nothing changes if that fails. Then only that provider opens the workspace, for everyone, Admins included.
- Before enforcing, or changing the issuer, a dialog lists the members and pending invites at another domain than yours, who then sign in only if the provider has an account with that exact address: **Enforce anyway** or **Cancel**.
- **Save and sign in again** changes the provider the same way. A new issuer or tenant signs everyone out; members sign in again, matched once by their invited address. A new client or secret for the same provider keeps everyone signed in.
- **Stop enforcing SSO**, below the form, signs everyone out (you included) and releases the claimed domains; people then use their own accounts. Refused when the deployment offers no account provider.

Until the workspace claims a domain, a session opened through its own provider opens only that workspace: it cannot list or open the person's other workspaces, or create one.

### Domains

**Domains** appears once the workspace enforces SSO. Each domain is **Claimed** or **Waiting for the DNS record**.

1. **Claim** a domain such as `example.com`. Spyria shows the TXT record to add (`spyria-verify=…`, with a copy button).
2. Add it at your DNS provider.
3. Click **Check the record**. DNS changes can take minutes, sometimes hours; the check says when the record is not found yet. **Cancel the claim** drops a domain still waiting.

Once claimed (see [who can join](../guides/who-can-join.md#good-to-know)):

- The domain's addresses sign in only through your provider, which also opens their other workspaces on this Spyria. They cannot create a workspace, and other workspaces cannot invite them.
- Members and invites at any other domain can no longer sign in to this workspace; inviting such an address is refused.
- **Release** frees the domain at once: its addresses sign in with their own accounts again.

Good to know:

- A domain claimed by another workspace of this Spyria is refused.
- A claim or **Release** that would leave your own address outside the workspace's claimed domains is refused.
- Claims and releases are recorded in the audit log.

## GitHub

**GitHub** sets up the workspace's GitHub App. Usage in dev chats: [Dev mode](./dev-mode.md).

- Create the App in one click (on your account or an organization), or use **Create it manually** for an App made by hand, for example on GitHub Enterprise without manifests.
- The App asks for contents, pull requests and workflows write; issues, checks, actions and metadata read. It subscribes to pull requests, reviews, review comments and threads, check suites and runs; for an App made by hand, the setup shows the webhook URL to enter.
- Once connected: **GitHub App connected**, **Create a new App** (replaces the connected one), **Edit credentials**, and the repositories the App's installations grant.
- **Members' accounts** shows each member's GitHub account as connected, needs reconnection, or not connected. The agent pushes and opens pull requests with the prompting member's account.
- Who may use GitHub's commands is set in **Tools**, which the card links to.

## Runtime hosts and members' machines

**Runtimes** lists runtime hosts with state, runtimes in use out of the cap, CPUs and memory; an amber badge means Docker runs as root or limits are not enforced. Use **Add runtime host**, or **Remove** in a host's menu. See [Machines](./machines.md).

**Member local runtimes** holds the switch **Members can run sessions on their own machine**. Turning it off stops members from adding a machine or starting a chat on one; prompts in existing ones get a notice.

**Setup commands** set what a dev chat's runtime runs when it starts, before the agent gets a message (see [Dev mode](./dev-mode.md#clone-and-setup-script)):

- **Default setup command** tab for repositories without their own; one tab per repository with its own; **New repository setup command** to add one.
- Nothing runs without one, not even a repository's `.spyria/setup.sh`.
- A repository's own setup command can keep up to 5 runtimes ready, set up on its default branch, so a new dev chat starts at once ([Runtimes kept ready](./dev-mode.md#runtimes-kept-ready)).
- Every member can read them, so they must hold no secret.

## Browser

**Browser** (needs **Manage the tools catalogue**) sets the browser each member gets in each AI chat, next to the chat's runtime (see [Chats and sharing](./chats-and-sharing.md#browser)):

- **Agents use a browser** and **Members browse** are separate. With members' browsing off, members watch the agent but cannot click or type. With both off, the Browser tab says the browser is off.
- **Ask before the agent submits** (on by default): the member approves each form the agent submits and each script it runs in their browser. Reading needs no approval.
- **Block internal networks** (on by default): pages cannot reach the host machine (`host.docker.internal`) or private, link-local and reserved addresses, checked on every address a name resolves to. Exceptions go in **Internal addresses allowed**, such as `staging.internal`. The chat's own runtime stays reachable as `localhost`.
- **Sites allowed** (empty means every site; `localhost` always is) and **Sites blocked**; each site includes its subdomains.
- **Sign-ins last at most**, in hours. By default a browser keeps its sign-ins until the chat's runtime stops. Past the limit, its host removes the browser and its sign-ins within a minute, even one in use.
- **Downloads** and **Uploads** (on by default).
- **Record visited addresses** (on by default): each visited address goes to the audit log under **Browser**, with its chat and member, without query or fragment, never page contents.

A change applies to the agent's next step and to each browser when it next starts, and is recorded in the audit log.

## Quality gates

**Quality gates** sets the checks a dev chat agent's work goes through before it reaches the owner. See [Dev mode](./dev-mode.md#quality-gates).

- **Default rules**, plus rules for each repository that needs its own (listed once GitHub is connected).
- Each set has its own switch, its gates and the limits of a run (time and cost).
- Gates run in order: commands, a code review, the pull request, CI. Each says whether a failure goes back to the agent (and how many times) or hands over to the owner.

## Tools

**Tools** lists tool servers as rows that open their details (a server waiting for a sign-in or review opens on its own).

**Spyria** comes first. Its tools are given to every role (boxes ticked and locked):

- Read: `open_page`, `browser_snapshot`, `browser_wait`, `browser_navigate`, `browser_screenshot`, `take_screenshot`, `web_search`, `list_public_chats`, `search_public_chats`, `read_public_chat`, `await_task`.
- Write: `browser_click`, `browser_type`, `browser_fill`, `browser_press`, `browser_run_javascript`, `delegate`, `check_task`, `finish_work`, `report_review`.
- Settings live with their feature, linked from the rows: **Browser** for `open_page` and the `browser_` tools, **Quality gates** for `finish_work` and `report_review`.

**GitHub** comes next:

- Read: `fetch_branch`, `read_review_threads`, `read_checks`, `list_issues`, `read_issue`. Write: `push_branch`, `open_pull_request`, `update_pull_request`.
- Its access grid sets the commands each role may use; approvals are in each member's profile. A role without a GitHub setting has every command, so dev chats work before you set access.
- Setup stays in **GitHub** (**Set up in GitHub**).
- The agent's GitHub tools, the Changes panel's Push and Open pull request, the pull request card's Address review comments and the quality gates all use this same access check.
- A catalogue server cannot be named GitHub.

### Adding a server

The rest is the workspace's catalogue of approved tool servers (MCP). Members cannot add servers of their own. **Add server** opens a dialog: a name (unique in the workspace), an address, and how members sign in.

**Each member signs in** (the default): each member connects their own account in **Profile** > **Connections**, and Spyria uses it on their chats.

1. Click **Sign in and add server**. A window opens.
2. Sign in once with your own account. The gateway uses this sign-in only to list the server's tools (servers such as Notion, Linear or Sentry answer nothing before a sign-in).
3. The server is ready once you have signed in.

- If the sign-in fails, Spyria removes the server and says why. If the window was closed early, it stays "Waiting for the sign-in that lists its tools" until removed.
- Its address cannot change once added: remove it and add it again.
- The server must let the gateway register itself (OAuth dynamic client registration). One that needs a pre-registered OAuth app, such as GitHub's MCP server, cannot be added yet.

**One shared login**: every member's calls use a secret header (name and value) you enter. For servers without their own sign-in, such as API-key or internal servers.

- The secret is stored in the model gateway only, never in Spyria's database, and never shown again.
- Changing the address or the header recreates the server in the gateway.

### Reviewing and granting access

A server's card heads with its state (**Waiting for the sign-in**, **To review**, or its tool counts, such as "12 tools · 8 read · 4 write") and a menu with **Edit**, **Correct read and write** and **Remove**.

**What each tool does**:

- Spyria marks each tool read or write from what the server says; correct any, then click **Confirm**. Nobody gets the server until you do.
- **Correct read and write** changes the markings later. New tools count as writing until you mark them.
- Tools the server marks destructive say so.

**Access by role**:

- Tabs **Read**, **Write** and **Destructive** each show a tool × workspace role grid of checkboxes, with a search. The checkbox under a role's name toggles every tool the tab shows.
- A role starts with no tool.
- Access is per role only: every member gets their role's, and a member who needs other tools needs another role.
- A member with no tool of a server does not see it.

### How access is enforced

- Each member's gateway key gets exactly the tools their access allows on each server; the gateway enforces it on every call. A role change gives the new role's tools at once.
- Servers of one workspace are invisible to other workspaces.
- Server changes reach running agents: Pi lists its tools again without a restart; Claude Code and Codex on a member's machine only if they support that notice.
- Removing a server also deletes every member's sign-in to it.
- An agent uses the access and accounts of the member who prompted: a per-member server answers with the prompter's sign-in; on a guest's prompt, a shared-login server needs both the owner's and the guest's access.
- Which calls wait for approval is chosen by the member whose account answers for the call, in their profile (see [Agents](./agents.md#tool-approvals)).

## AI providers

**AI providers** chooses which model providers members can use. By default every provider is allowed. Turning one off makes the setting an allow-list; a provider that is on allows all its models. For a provider that is off:

- members cannot add a key for it ("OpenAI is not allowed in this workspace");
- its models are not offered in the model picker, nor chosen by routing or for sub-agents;
- Spyria refuses a call to its models before it reaches the provider, and the chat shows "*Model* is not allowed in this workspace".

**Turn every provider on**, shown while a provider is off, removes the allow-list.

Providers are listed in two groups:

- Labs: Anthropic, OpenAI, Google Gemini, Mistral, xAI, DeepSeek, Z.ai, Meta, and TypeSafe (whose decision models route turns). Meta is reached through the OpenAI-compatible Meta Model API (`api.meta.ai`), with Muse Wonder as its large model and Muse Spark as its medium one.
- Routers: OpenRouter.

Good to know:

- Keys already added for a provider turned off stay in the member's profile but reach no model.
- Sessions on a member's own machine (Claude Code, Codex) use their own subscription and are not covered.
- Each change is recorded in the audit log.

## Spend

**Costs and AI budgets** has two tabs: **Costs** (**View costs**) and **AI budgets** (**Manage budgets**); a member with only one sees just that page.

**Costs** reports the cost of model calls made through the gateway. A notice says sessions on a member's own machine are not counted.

Filters, on one row, narrow everything below:

- period: this month, last month, last 30 or 90 days, or custom up to a year;
- granularity: day, week or month;
- **Whole workspace**, or some members, projects, chats or models of one kind, picked from a checkbox list offering every one with usage in the period or the one before.

The page shows:

- spend over time, stacked by member, project or model;
- tables per member, project, chat and model: cost, tokens, requests and share;
- a breakdown of spend into users × sessions per user × turns per session × requests per turn × tokens per request × price per token, against the previous period, highlighting the factor that moved most. Click a row to chart it over time;
- cost per merged pull request (always whole workspace): average cost over time, a histogram, and **Export data**, a CSV of each merged pull request with merge time, chat, title, link and its chat's cost.

Good to know:

- Calls delegated to sub-agents count in the turn that delegated them.
- Every member sees their own figures, never anyone else's, in **Profile** > **Usage**, with their own cost per merged pull request (pull requests merged from chats they prompted in, against what they spent there).
- Sessions on a member's own Claude or ChatGPT subscription are not metered by Spyria and do not appear.

## Budgets

On **AI budgets**, a member with **Manage budgets** sets, in a grid of workspace roles, an optional budget in dollars per role for each day, week (from Monday) and month, in UTC.

- **Per member.** Each member gets their role's budget for themselves; it is not shared. Under each budget the grid shows the role's total: "$5.00 × 3 members = $15.00".
- **Workspace total.** The last row sums the roles' totals per period. It cannot be set, and shows **No limit** while a role with members has no budget for that period.
- **Alerts** at 80% and 100%, once per threshold, member and period:
  - the member sees a banner on **Profile** > **Usage** and a notice above the composer ("You have used 80% of your daily AI budget");
  - admins see a badge on the **Costs and AI budgets** card, a notice on its page, and the members above 80%.
- **Hard stop** at 100% of any period: the member's model calls are refused before reaching the provider until the period ends, including their running sub-agents' calls and the routing call of their next turn. The chat shows "<Name>'s daily AI budget is used up; a member with the Manage budgets permission can raise it in Workspace settings", naming the longest period used up.
- Raising or removing the role's budget lets its members prompt again at once. A member given another role gets that role's budgets.

Good to know: spend comes from the gateway's usage records, read every few seconds, and a call is priced only after it ran. A budget can be exceeded by the last few seconds of calls, typically cents.

## Deleting the workspace

**Delete workspace** is at the bottom of **Workspace settings**. It is not a card and no workspace role can grant it: only members with the built-in Admin role see it, and the server checks the same. The dialog lists what goes and asks you to type `DELETE`.

At once:

- every member loses access: sessions end, open agent streams close, running runtimes stop;
- background work, GitHub webhooks, and agents' and sub-agents' model calls are refused;
- the workspace disappears from everyone's workspace switcher.

A few minutes later, runtimes that were still starting are removed, so a restored workspace starts them afresh.

Seven days later, Spyria erases for good: chats and their whole history, runtimes with their containers and files on the hosts, members' model keys in the gateway, the tools catalogue, the link to the GitHub App, the sign-in settings, the audit log, and the people who belonged to no other workspace and never signed in with an account of their own.

Good to know:

- The GitHub App stays installed on the organization: uninstall it on GitHub.
- Until the seven days are over, only the operator can restore the workspace ([operations](../guides/operations.md#deleting-a-workspace)).
- When a deployment's only workspace is erased, creating one needs the setup link again ([who can join and sign-in](../guides/who-can-join.md)).

## Audit log

**Audit log** shows, newest first, who changed what: time, person, action in plain words, target, and details on expand, with each day as a heading over its first record. The person is:

- a member;
- "Alice's agent" for what an agent did in Alice's turn;
- "System" for a job, with the member it acted for when there is one;
- "GitHub" for pull request changes from GitHub.

| Group | Records |
|---|---|
| Members | invites, revoked invites, joins, role changes, removals, sign-outs everywhere |
| Workspace | workspace deleted, restored by the operator, AI providers allow-list changed, quality gates changed, setup commands changed |
| Sign-in | SSO configured, client secret replaced, SSO stopped, domains claimed and released |
| GitHub | App configured, App secrets replaced |
| Tools | tool servers added, changed, removed, reviewed, and changes to who may use them |
| Chats | chat members added, removed, leaving, role changes, visibility changes, transfers, chats started from another chat, deleted messages with their text |
| Tool calls | every agent tool call, with prompter, owner, server, tool, whether it writes, approval decision and outcome |
| Browser | browser settings changed, addresses visited |
| Publishing | pushes, pull requests opened, reopened, turned into drafts, merged, closed |
| Budgets | role budget changes, thresholds reached |
| Roles | custom chat and workspace roles created, changed, deleted |

- The log records metadata only. One exception: a **Deleted a message** record shows the text the message had when deleted, in any chat, private ones included, since the chat no longer shows it. It never shows the body of a message still in a chat.
- Filter by person (which also lists what was done on their behalf), group and date range. **Export CSV** downloads the filtered records.

### Retention

**Keep audit records**, under **Retention** at the top of the page, is changed by members with **Change how long audit records are kept** (others only read it).

- Forever by default, or a number of days (1 to 36,500).
- A daily job deletes workspace events, tool call records and texts of deleted messages older than that.
- Chat events are the conversation history itself and are deleted only with the workspace; past the retention they only drop out of the audit view.
- Changing the retention is itself recorded.

Related: [Who can join and sign-in](../guides/who-can-join.md).

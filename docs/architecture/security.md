# Security

This page describes who can do what in Spyria and where each credential lives. It is for operators deciding whether to trust a deployment and for contributors changing anything near sign-in, permissions, credentials or logs. The overall picture is in the [overview](overview.md).

## Principles

- **Everything is scoped to a workspace.** Every table except a person's own identity (`users`, `account_identities`) carries `workspace_id`, and every query and mutation filters on the caller's workspace.
- **A credential stays with its owner.** A member's provider keys live in the gateway, their subscription sign-ins on their own machine, their GitHub token on the server. None of them reaches a runtime.
- **Secrets never appear in logs, errors or URLs.**

## Signing in

Production sign-in is single sign-on only, through OpenID Connect; there are no passwords and no email codes ([decision 0029](../decisions/0029-account-sign-in-and-workspace-sso.md)). People sign in with an account at a provider of the deployment (Google, Microsoft through its `common` authority, or one OIDC issuer, set by the operator), or through a workspace's own provider when it enforces SSO (Google Workspace, Microsoft Entra of one tenant, or any OIDC issuer; [decision 0012](../decisions/0012-per-workspace-sso.md)).

- **Identities bind to the provider's account**, never to the email alone: issuer and subject, or the object id for Microsoft. An address binds only the first account of the person with that address; later address changes at the provider keep the account, and any other account carrying the same address, at the same provider or another, is refused. A Google or generic OIDC address counts only when the provider confirms it (`email_verified`, [decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)); a Microsoft guest of another tenant is never matched by address.
- **Every sign-in is checked as OIDC requires:** a login carries its own state, nonce and PKCE verifier (S256) in a signed cookie for 5 minutes; the callback refuses another state, an authorization response naming another issuer, and an ID token from another issuer or audience, with another nonce or none, a bad signature, expired, not valid yet, issued in the future or over an hour ago. A code issued to another login is refused by the provider, since its verifier does not match. The app accepts the sign-in popup's answer only from that popup, served from its own origin or the sign-in callback's (the same one in production).
- **Sign-in routes only by invite and membership.** The screen asks for an address and shows the deployment's account providers plus the providers of workspaces enforcing SSO where that address is invited or a member, labelled by kind only, never by workspace name. Who joins what is decided only once the provider confirms the address.
- **Invites** are an allow-list kept by admins: an exact address, a role and an expiry of 7 days. They work at once and send no email; nobody joins a workspace any other way.
- **Workspace SSO** is the corporate control: once a workspace enforces its own provider, only that provider opens it, for everyone, Admins included. An Admin confirms it by signing in through the provider with their own address. A new provider, or no longer enforcing SSO, ends every session in the workspace.
- **A workspace's provider opens only that workspace.** A session opened through it cannot list or open the person's other workspaces, or create a workspace; keys, connections, machines and sessions belong to each membership anyway.
- **Creating workspaces.** Anyone signed in with an account can create one. The first workspace of an empty deployment needs the setup link (`<origin>/?setup=<SPYRIA_SETUP_TOKEN>`; without it the page only says the deployment is being set up, so nobody can claim a fresh install before its owner), and its creator signs in with an account provider or with the organization's provider, which the workspace then enforces.
- **Sessions.** After sign-in the server keeps a session row (7 days) and sets an `HttpOnly`, `SameSite=Lax` cookie per workspace, scoped to `/auth` and `Secure` everywhere but `localhost`. Renewing and signing out answer only a request whose `Origin` is `SPYRIA_APP_ORIGIN` and that carries the `X-Spyria-CSRF` header, and the server allows no other origin (no CORS): the app and its API share one origin ([decision 0017](../decisions/0017-one-compose-file-one-origin.md)), and serving the app from another origin would need these checks revisited. The web app trades it for a short-lived signed token (15 minutes) that it sends on every API call, Zero sync and agent stream, and renews it in the background. A removed member's sessions stop working at the next check, and their open agent streams are closed. An agent stream is also closed when its session signs out, and when its token expires without the renewed token reaching it, so a session that ends any other way keeps its stream for 15 minutes at most.
- **Ending sessions.** **Profile** > **Sessions** lists where a member is signed in to the workspace (browser, system and when, marking this device), never a session's id, and **Sign out everywhere** ends all of their sessions in it and closes their open agent streams. A member with `members.manage` does the same for a member whose role they could grant, recorded in the audit log. Both are per workspace, like everything a membership holds: a member signed in to several workspaces signs out of each one. A session keeps the time of the provider sign-in it came from, also when it opened another workspace from a session of the person, and a session signed in before the sign-out cannot open the workspace again, directly or through another workspace; only a new sign-in through the provider does, so after a lost device the member is also signed out at the provider.

Development and tests sign in through a local Dex instead (`SPYRIA_AUTH_MODE=dex`); production refuses that mode. See [manual install](../guides/self-hosting.md) for the setup and [decisions](../decisions/) for why.

## Permissions and roles

Spyria checks permissions, never role names. A role is a named set of permissions, so a custom role is a new row, not new code.

- **Workspace roles** carry workspace permissions (inviting, managing members and roles, SSO, GitHub, runtimes, costs, budgets, audit). The built-in Admin role has all of them, Member none; admins can add custom roles.
- **Chat roles** carry chat permissions (reading, prompting, configuring the session, inviting, managing participants, administering the chat). The built-ins go from Owner to Reader, and custom roles work the same way.
- A member can grant only a role whose permissions they hold themselves. Public chats, channels or AI chats, give every workspace member read and post without a role; private chats are open to their owner and invitees only. In a public AI chat a member who is not the owner prompts as a guest ([0009](../decisions/0009-agent-acts-as-the-owner.md)).

The permissions and built-in roles are defined in `packages/kernel/src/workspace-access.ts` and `packages/kernel/src/chat-access.ts`. How admins and owners use them: [admin](../features/admin.md) and [chats and sharing](../features/chats-and-sharing.md).

## What the agent may do

The agent of a chat acts for the chat's **owner**, and its model calls are paid by the member who **prompted**:

- **Model calls** run on the prompter's own provider key, through the gateway. Each call records the chat, the prompter and the owner.
- **Tool calls** (MCP) use the owner's access to the workspace's tools catalogue. On the owner's own prompt the agent may use the catalogue servers the owner can use: those with one shared login, and those the owner signed in to with their own account. An owner needs no provider key for this: their gateway key serves tools on its own ([0023](../decisions/0023-gateway-keys-serve-tools-without-model-keys.md)).
- **On a guest's prompt** (an Editor or Prompter), the agent may use only the shared-login servers, with the tools both the owner and the guest can use, never a server the owner signed in to with their own account, and a write call waits for the owner's approval in the chat unless the owner chose otherwise ([0031](../decisions/0031-tool-access-levels-and-approvals.md)).
 Spyria's own `open_page` and `take_screenshot` are the exceptions: they use none of the owner's connections or credentials, the first only lists a page that members load themselves (and never one on their own machine or network), and the second only makes requests from inside the runtime, which the agent's shell can make anyway, including to cloud metadata addresses the runtime reaches. The agent never exceeds what the person prompting could do, and the owner is never answerable for an action they did not approve.
- **Sessions on a member's own machine** accept prompts from their owner only.
- **Publishing to GitHub** is reserved to the chat owner, with the owner's own GitHub account (see below).

## Credentials

| Credential | Where it lives | Who uses it |
|---|---|---|
| A member's provider API keys | The gateway, encrypted with its own key. Spyria stores a reference and the last four characters (at most half of a short key). | The server's relay, for that member's prompts only. |
| A member's tool OAuth tokens | The gateway, against the member's key for that workspace. Disconnecting deletes the gateway's copy; the gateway never returns the token, so the grant at the provider stays until the member removes it there, which the profile tells them after a disconnect. | The relay, on that member's chats. |
| The token of the Admin who added a server each member signs in to | The gateway, against that server: the Admin signs in once when adding it. | The gateway, only to list the server's tools; members' calls use their own tokens. |
| A shared-login server's secret header | The gateway, in plain text in its admin API: the gateway is reachable on the internal network only, and Spyria never logs or returns what that API answers. | The gateway, on calls to that tool server. |
| The token a runtime holds | Issued by Spyria per runtime, stored as a hash. | Valid only through Spyria's relay, during an active turn, for that turn's prompter. A runtime never sees a real provider key. |
| The key the server uses to reach a runtime's agent | Not stored: derived from a secrets key and the runtime's id when the runtime is created and on each call. The runtime records only the id of that key, so it keeps answering after a rotation until it is recreated with the current key. | The server, to talk to that runtime only. |
| Claude Code and Codex sign-ins | Docker volumes on the member's own machine. | The member's own sessions there. |
| SSO client secrets, GitHub App credentials | Postgres, sealed with AES-GCM under `SPYRIA_SECRETS_KEY`. Shown only as "set". | The server. |
| A member's GitHub token | Postgres, sealed. | The server, to push and open pull requests for that member's chats. |
| A runtime host's pairing token | The host's state volume. | The host, to dial in. |

### Subscriptions stay on the member's machine

Claude Code and Codex subscriptions may not be used by a third-party service, so Spyria never handles them. A member who wants to use their plan runs `spyria-host` in personal mode on their own machine and signs in there. Because the agent in that session can read the sign-in just as it could on a laptop, the host protects what leaves the machine instead:

- it forwards only the requests Spyria needs (start a conversation, prompt, interrupt, answer a question, read the working copy) and refuses anything else;
- it replaces token formats and the current token values with `[redacted]` in every frame it sends to the server.

Admins can turn these sessions off for the workspace. See [machines](../features/machines.md).

### GitHub tokens never enter a runtime

- **Cloning** uses a short-lived installation token of the workspace's GitHub App, limited to reading that one repository. It is passed to `git` as a one-off header, so it is not left in the runtime's environment or in `.git/config`.
- **Publishing** runs on the server: the runtime hands over a git bundle of the working branch, and the server pushes it with the owner's own token. A runtime has nothing it could push with.
- **Workflows.** The GitHub App asks for the Workflows permission, so the agent can change files under `.github/workflows` and the server pushes them with the owner's token. A pushed workflow runs on GitHub with the repository's secrets. An admin who does not want agents to change workflows does not accept that permission on the installation; GitHub then refuses any push that changes one.
- **Fetching and reading** run on the server too: the agent's `fetch_branch` gets a git bundle the server built with a read-only installation token, and its review-thread and issue tools answer from read-only installation tokens. Issue and comment text comes from anyone who can comment on the repository and reaches the agent unchanged.
- **Webhooks** are accepted only with a valid `X-Hub-Signature-256` for the App's webhook secret; a delivery id already received is ignored.

## Runtimes and hosts

- A runtime host **dials out** to the server and accepts a fixed set of commands, each validated field by field. Spyria never opens a port on a host and never gets general access to its Docker.
- Each runtime container runs as an unprivileged user with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, and limits on memory (2 GiB), CPU (2) and processes (512). Docker's init runs as its PID 1 and reaps orphaned processes, so killed commands do not stay as zombies against the process limit. It runs only the image the server names, and a host accepts just two forms of it: the published `spyria-agent` of the namespace its own image came from, by digest (pulled when missing; a tag, another name or another registry is refused), or a local content ID.
- A host and spyria-agent declare a protocol version; the server refuses a host below its minimum ("This host is out of date") and fails a runtime whose agent is below it, so a security fix in the host or the agent is enforced by raising the minimum: an old host, with its old command validation, token redaction and harness pins, cannot stay connected ([machines](../features/machines.md#versions-and-updates)).
- Each runtime has its own Docker network, so runtimes on one host cannot reach each other where Docker isolates networks (Docker Engine on Linux). The name `host.docker.internal` resolves to the host machine in every runtime, as on Docker Desktop, so a host run outside a container can give its runtimes its model relay address; the machine was already reachable through the network's gateway.
- Spyria does not filter runtimes' outbound traffic. On cloud machines, block the metadata endpoint (`169.254.169.254`) and private ranges in the provider's firewall. See [manual install](../guides/self-hosting.md).

## In the browser

The server sends the web app with a Content Security Policy (`apps/server/src/web-app.ts`): it runs only its own scripts, connects only to its own origin, and cannot be framed by another site. The **Browser** tab asks the server for a web page (`/api/web-page`, rate limited per member): the server resolves the name, refuses private, loopback, link-local and reserved addresses, connects to the address it checked so a second DNS answer cannot point it elsewhere, checks every redirect the same way, and stops after 15 seconds or 5 MB. The page is handed to `/page-frame.html`, a sandboxed frame whose policy blocks the page's scripts; the frame's own script only reports the links and forms the member follows. A page on the member's own machine (`localhost`) is framed directly in a sandbox. A report the agent wrote never runs in the app's page: it is handed to `/report-frame.html`, a sandboxed frame with a policy of its own that lets the report run its scripts and load what it needs, without the app's origin, storage or session.

## Rate limits and retries

The server limits sign-in, setup link checks, host connections, sync connections (`/zero` WebSockets, which the server accepts before it opens one to zero-cache), webhooks, invites, prompts, messages and new chats with in-memory token buckets, keyed by client address, workspace or member, and answers `429` with `Retry-After`. The budgets are defined in `apps/server/src/rate-limits.ts`. Behind a proxy, the client address is the socket address unless `SPYRIA_TRUSTED_PROXY=cloudflare` makes the server read Cloudflare's `CF-Connecting-IP` header; set it only when the server is reachable through Cloudflare alone.

Outbound calls have timeouts; calls that are safe to repeat are retried a few times with backoff, only on network errors and temporary HTTP failures (`packages/kernel/src/retries.ts`).

## Budgets

Budgets are a hard stop, enforced by the relay before each model call: when the prompter's monthly budget or the workspace's is used up, the call is refused and the chat says why. Spend is read from the gateway's logs every few seconds, so a call already in flight can overshoot a budget slightly. See [admin](../features/admin.md).

## Secrets at rest

- `SPYRIA_SECRETS_KEY` seals SSO client secrets, the GitHub App's credentials and members' GitHub tokens, and derives the key the server uses to reach each runtime. Each sealed value starts with the id of the key that sealed it (a hash prefix, never the key). It is [rotated](../guides/operations.md#rotating-the-secrets-key) by keeping the previous key in `SPYRIA_PREVIOUS_SECRETS_KEYS`, which still opens and still reaches runtimes but seals nothing, sealing every stored secret again with the `secrets:reseal` operator command, and removing the previous key once no running runtime uses it. A runtime moves to the current key the next time it starts.
- The gateway's encryption key seals members' provider keys in the gateway's database. It cannot change without wiping that database.
- `SPYRIA_TOKEN_SECRET` signs session tokens; changing it signs everyone out.

In production the server refuses to start while any of these is missing, shorter than 32 characters or still a development default ([manual install](../guides/self-hosting.md) lists every check).

## What is logged, and what never is

Logs are one JSON line per event with a name, a one-sentence message, ids (workspace, chat, member, job, trace) and outcome attributes. See [operations](../guides/operations.md).

Never logged, returned in errors or put in URLs: tokens, keys, passwords, cookies, request bodies, prompts and model output. The server's log exporter also drops any attribute whose name contains a part such as `token`, `secret`, `password`, `authorization`, `cookie`, `key`, `body`, `prompt`, `content` or `query`, as a second line of defence. A failed database query is logged, and shown in a chat notice, by its class and database code only, never with its parameters; a failed job keeps only the class and code of its last error (or the message of a Spyria error, which carries ids only).

What is recorded on purpose, for accountability: every model call and every tool call with its chat, prompter and owner; workspace admin actions and chat membership changes in the audit log; agent events in the chat's append-only history.

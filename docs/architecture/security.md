# Security

This page describes who can do what in Spyria and where each credential lives. It is for operators deciding whether to trust a deployment and for contributors changing anything near sign-in, permissions, credentials or logs. The overall picture is in the [overview](overview.md).

## Principles

- **Everything is scoped to a workspace.** Every table except a member's own identity (`users`) carries `workspace_id`, and every query and mutation filters on the caller's workspace.
- **A credential stays with its owner.** A member's provider keys live in the gateway, their subscription sign-ins on their own machine, their GitHub token on the server. None of them reaches a runtime.
- **Secrets never appear in logs, errors or URLs.**

## Signing in

Production sign-in is single sign-on only, one OpenID Connect provider per workspace (Google Workspace, Microsoft Entra or any OIDC issuer). The sign-in screen asks for a work email; its domain picks the workspace's provider. A member's identity is matched on the provider's issuer and subject, not on the email alone.

- **The first workspace** is created from the sign-in page of an empty deployment: organization name, email domain and provider. The first person who completes sign-in at that provider with an address at that domain becomes its Admin. Once a workspace exists, the page no longer offers this and the server refuses it.
- **Domain verification.** A workspace stays unverified until an Admin proves control of its domain by opening a single-use link (valid 24 hours) sent to any address at that domain. Until then nobody can be invited and the domain routes sign-in only for existing members. A workspace has exactly one domain, set at creation.
- **Invites** are an allow-list kept by admins: an email, a role and an expiry of 7 days. The invitee signs in through the workspace's provider; no invite email is sent.
- **Sessions.** After sign-in the server keeps a session row (7 days) and sets an `HttpOnly`, `SameSite=Lax` cookie per workspace, scoped to `/auth` and `Secure` everywhere but `localhost`. The web app trades it for a short-lived signed token (15 minutes) that it sends on every API call, Zero sync and agent stream, and renews it in the background. A removed member's sessions stop working at the next check, and their open agent streams are closed. An agent stream is also closed when its session signs out, and when its token expires without the renewed token reaching it, so a session that ends any other way keeps its stream for 15 minutes at most.

Development and tests sign in through a local Dex instead (`SPYRIA_AUTH_MODE=dex`); production refuses that mode. See [self-hosting](../guides/self-hosting.md) for the setup and [decisions](../decisions/) for why.

## Permissions and roles

Spyria checks permissions, never role names. A role is a named set of permissions, so a custom role is a new row, not new code.

- **Workspace roles** carry workspace permissions (inviting, managing members and roles, SSO, GitHub, runtimes, costs, budgets, audit). The built-in Admin role has all of them, Member none; admins can add custom roles.
- **Chat roles** carry chat permissions (reading, prompting, configuring the session, inviting, managing participants, administering the chat). The built-ins go from Owner to Reader, and custom roles work the same way.
- A member can grant only a role whose permissions they hold themselves. Public channels give every workspace member read and post without a role; agent chats are private to their owner and invitees.

The permissions and built-in roles are defined in `packages/kernel/src/workspace-access.ts` and `packages/kernel/src/chat-access.ts`. How admins and owners use them: [admin](../features/admin.md) and [chats and sharing](../features/chats-and-sharing.md).

## What the agent may do

The agent of a chat acts for the chat's **owner**, and its model calls are paid by the member who **prompted**:

- **Model calls** run on the prompter's own provider key, through the gateway. Each call records the chat, the prompter and the owner.
- **Tool calls** (MCP) use the owner's connections. On the owner's own prompt the agent may use the workspace connections the owner can use and the owner's personal connections. An owner needs no provider key for this: their gateway key serves tools on its own ([0023](../decisions/0023-gateway-keys-serve-tools-without-model-keys.md)).
- **On a guest's prompt** (an Editor or Prompter), the agent may use only the workspace connections that both the owner and the guest can use, never the owner's personal connections, and every tool call that is not marked read-only waits for the owner's approval in the chat. Spyria's own `open_page` and `take_screenshot` are the exceptions: they use none of the owner's connections or credentials, the first only lists a page that members load themselves (and never one on their own machine or network), and the second only makes requests from inside the runtime, which the agent's shell can make anyway, including to cloud metadata addresses the runtime reaches. The agent never exceeds what the person prompting could do, and the owner is never answerable for an action they did not approve.
- **Sessions on a member's own machine** accept prompts from their owner only.
- **Publishing to GitHub** is reserved to the chat owner, with the owner's own GitHub account (see below).

## Credentials

| Credential | Where it lives | Who uses it |
|---|---|---|
| A member's provider API keys | The gateway, encrypted with its own key. Spyria stores a reference and the last four characters (at most half of a short key). | The server's relay, for that member's prompts only. |
| A member's tool OAuth tokens | The gateway, against the member's key for that workspace. Disconnecting deletes the gateway's copy; the gateway never returns the token, so the grant at the provider stays until the member removes it there, which the profile tells them after a disconnect. | The relay, on that member's chats. |
| A workspace connection's secret header | The gateway, in plain text in its admin API: the gateway is reachable on the internal network only, and Spyria never logs or returns what that API answers. | The gateway, on calls to that tool server. |
| The token a runtime holds | Issued by Spyria per runtime, stored as a hash. | Valid only through Spyria's relay, during an active turn, for that turn's prompter. A runtime never sees a real provider key. |
| The key the server uses to reach a runtime's agent | Not stored: derived from `SPYRIA_SECRETS_KEY` and the runtime's id when the runtime is created and on each call. | The server, to talk to that runtime only. |
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
- **Fetching and reading** run on the server too: the agent's `fetch_branch` gets a git bundle the server built with a read-only installation token, and its review-thread and issue tools answer from read-only installation tokens. Issue and comment text comes from anyone who can comment on the repository and reaches the agent unchanged.
- **Webhooks** are accepted only with a valid `X-Hub-Signature-256` for the App's webhook secret; a delivery id already received is ignored.

## Runtimes and hosts

- A runtime host **dials out** to the server and accepts a fixed set of commands, each validated field by field. Spyria never opens a port on a host and never gets general access to its Docker.
- Each runtime container runs as an unprivileged user with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, and limits on memory (2 GiB), CPU (2) and processes (512). It runs only an image identified by its local content ID; hosts never pull.
- Each runtime has its own Docker network, so runtimes on one host cannot reach each other where Docker isolates networks (Docker Engine on Linux). The name `host.docker.internal` resolves to the host machine in every runtime, as on Docker Desktop, so a host run outside a container can give its runtimes its model relay address; the machine was already reachable through the network's gateway.
- Spyria does not filter runtimes' outbound traffic. On cloud machines, block the metadata endpoint (`169.254.169.254`) and private ranges in the provider's firewall. See [self-hosting](../guides/self-hosting.md).

## Rate limits and retries

The server limits sign-in, host connections, webhooks, invites, prompts, messages and new chats with in-memory token buckets, keyed by client address, workspace or member, and answers `429` with `Retry-After`. The budgets are defined in `apps/server/src/rate-limits.ts`. Behind a proxy, the client address is the socket address unless `SPYRIA_TRUSTED_PROXY=cloudflare` makes the server read Cloudflare's `CF-Connecting-IP` header; set it only when the server is reachable through Cloudflare alone.

Outbound calls have timeouts; calls that are safe to repeat are retried a few times with backoff, only on network errors and temporary HTTP failures (`packages/kernel/src/retries.ts`).

## Budgets

Budgets are a hard stop, enforced by the relay before each model call: when the prompter's monthly budget or the workspace's is used up, the call is refused and the chat says why. Spend is read from the gateway's logs every few seconds, so a call already in flight can overshoot a budget slightly. See [admin](../features/admin.md).

## Secrets at rest

- `SPYRIA_SECRETS_KEY` seals SSO client secrets, the GitHub App's credentials and members' GitHub tokens, and derives the key the server uses to reach each runtime. It cannot change without entering every secret again, and the runtimes created before the change would stop answering the server.
- The gateway's encryption key seals members' provider keys in the gateway's database. It cannot change without wiping that database.
- `SPYRIA_TOKEN_SECRET` signs session tokens; changing it signs everyone out.

In production the server refuses to start while any of these is missing, shorter than 32 characters or still a development default ([self-hosting](../guides/self-hosting.md) lists every check).

## What is logged, and what never is

Logs are one JSON line per event with a name, a one-sentence message, ids (workspace, chat, member, job, trace) and outcome attributes. See [operations](../guides/operations.md).

Never logged, returned in errors or put in URLs: tokens, keys, passwords, cookies, request bodies, prompts and model output. The server's log exporter also drops any attribute whose name contains a part such as `token`, `secret`, `password`, `authorization`, `cookie`, `key`, `body`, `prompt`, `content` or `query`, as a second line of defence. A failed database query is logged, and shown in a chat notice, by its class and database code only, never with its parameters; a failed job keeps only the class and code of its last error (or the message of a Spyria error, which carries ids only).

What is recorded on purpose, for accountability: every model call and every tool call with its chat, prompter and owner; workspace admin actions and chat membership changes in the audit log; agent events in the chat's append-only history.

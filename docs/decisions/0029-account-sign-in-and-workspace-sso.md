# 0029. Sign in with an account; a workspace may enforce its own SSO

## Context

[Decision 0012](0012-per-workspace-sso.md) tied every workspace to an email domain proven by an emailed link, and [decision 0027](0027-join-by-invited-address.md) added a second, instance-wide way to join, by invited address through one shared sign-in app. Neither fits a deployment that serves both: a person with a Gmail account who wants a workspace of their own, and an organization that wants only its own provider to open its workspace. Domains also brought mail, a verification step before any invite, a refusal of public domains and a race for who claims a domain first.

## Decision

- **Accounts.** People sign in with an account at a provider the instance offers, set by the operator: Google (any account, Gmail included), Microsoft (work or school accounts of any tenant and personal accounts, through the `common` authority, the token's issuer checked against its own tenant) and any OIDC provider (`SPYRIA_OIDC_*`). There is no email code or password. An account is its provider identity (issuer and subject, the object id for Microsoft) in `account_identities`; the address the provider confirms binds only the first account of a person, and any later account carrying that address, at the same provider or another, is refused. Through Microsoft, an account reads only the user principal name, never the mail attribute a tenant can set freely.
- **Workspaces.** Anyone signed in creates a workspace; a one-member workspace is the personal case. Members join only by an invite to an exact address, accepted when a provider confirms that address; there is no auto-join and no domain.
- **Enforced SSO.** A workspace may enforce its own provider (Google Workspace, Microsoft Entra of one tenant, or any OIDC issuer). Then only that provider opens it, for everyone, Admins included. The Admin confirms a new provider by signing in through it with their own address; a new issuer, or turning enforcement on or off, ends every session of the workspace. Its identities stay per workspace in `identities`.
- **Safety rule.** A workspace's own provider opens only that workspace, never account-level data: a session it opens cannot open, list or create other workspaces of the person. Keys, connections, machines and sessions are stored per membership, so they stay inside the workspace. `account_identities` is the one table besides `users` without `workspace_id`, because an account exists before and across workspaces.
- **Routing.** Sign-in is email-first and routes only by invite and membership: an address gets the account providers of the instance, plus one entry per enforcing workspace where it is invited or a member, labelled by the kind of provider, with no workspace name or id. Who joins what is decided only once the provider has confirmed the address.
- **No domain claim.** Workspaces own no domain. Domain verification, its mail, the join-by setting and the shared sign-in app are deleted. The trust a verified domain gave an empty deployment comes from the operator's setup link, still required for the first workspace.
- **Existing workspaces** keep their provider with SSO enforced; their domain stops routing and their members keep access through their memberships.

Supersedes [decision 0027](0027-join-by-invited-address.md) and amends [decision 0012](0012-per-workspace-sso.md) and [decision 0020](0020-instance-sign-in-apps.md); [decision 0028](0028-generic-oidc-must-confirm-addresses.md) holds for accounts and workspace providers alike.

## Alternatives

- **Keep domains next to accounts.** Domain routing would let an organization's people land on its provider without an invite, but it brings back verification mail and the race for a domain, and it says where an address belongs before any provider confirms it.
- **One provider per instance.** It cannot serve both a person with Gmail and an organization whose workspace must open only through its own provider.

## Consequences

- A person needs nothing but an account at a provider the instance offers; an organization gets its corporate control by enforcing its provider on its workspace.
- Typing an address shows whether it is invited to, or a member of, a workspace that enforces SSO, by the extra provider entry; nothing else is revealed before the provider confirms the address.
- An instance without account providers works only with workspaces enforcing their own provider, and nobody creates more workspaces there.
- The operator's Microsoft app must accept personal accounts as well as any tenant.

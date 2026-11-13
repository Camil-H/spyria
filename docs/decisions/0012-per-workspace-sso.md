# 0012. Per-workspace SSO

Amended by [decision 0029](0029-account-sign-in-and-workspace-sso.md): workspaces own no email domain, people sign in with an account at any provider the instance offers, and a workspace may enforce its own provider. Amended again by [decision 0035](0035-domain-claims.md): a workspace enforcing its provider may claim email domains, proven by a DNS record only.

## Context

Spyria is self-hosted by organizations that already have an identity provider, and used by people and small teams who have none. A sign-in of Spyria's own (passwords, magic links, emailed codes) would make Spyria an identity provider; one global provider per deployment would not fit organizations with their own. Signing in with any account at a provider the instance offers (Google, Gmail included, Microsoft, any OIDC provider) is acceptable once access to a workspace is bounded by its Admin's invites and, for an organization, by its own provider ([decision 0029](0029-account-sign-in-and-workspace-sso.md)).

## Decision

- Production sign-in is single sign-on only. A workspace may bring its own OpenID Connect provider: Google Workspace and Microsoft Entra as presets, or any OIDC issuer. Identities are matched on issuer and subject.
- Sign-in is email-first: the address shows the providers of the instance and those of the workspaces where it is invited or a member; nothing routes by domain.
- An empty deployment offers "Create a workspace" only through the operator's setup link. Once a workspace exists, anyone signed in with an account can create one.
- A workspace owns no email domain. Invites open at once, to exact addresses.
- Invites are an admin-kept allow-list; no invite email is sent.
- Dex is for development and tests only; production refuses it.

## Consequences

- An organization that enforces its own provider keeps access following that provider, including leavers.
- A deployment needs no mail.
- Several organizations can share one deployment: none claims a domain.

# 0012. Per-workspace SSO with emailed domain verification

## Context

Spyria is self-hosted by organizations that already have an identity provider. A shared consumer sign-in (any Google account, magic links) would let anyone create an identity; one global provider per deployment would not fit organizations with their own.

## Decision

- Production sign-in is single sign-on only. Each workspace brings its own OpenID Connect provider: Google Workspace and Microsoft Entra as presets, or any OIDC issuer. Identities are matched on issuer and subject.
- Sign-in is email-first: the address's domain routes to the provider of the workspace using that domain.
- An empty deployment offers "Create a workspace" on its sign-in page; the first person to complete sign-in at the chosen provider with an address at the chosen domain becomes the Admin. After that, nobody can bring a new domain to the deployment.
- A workspace has one domain and stays unverified until an Admin opens a single-use link emailed to an address at that domain. Before that, no invites and no sign-in routing beyond existing members.
- Invites are an admin-kept allow-list; no invite email is sent.
- Dex is for development and tests only; production refuses it.

## Consequences

- Access follows the organization's own identity provider, including leavers.
- A deployment needs SMTP for verification (or an operator command to verify a domain directly).
- One organization per deployment in practice; a second organization's domain cannot join an existing instance.

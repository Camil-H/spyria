# 0027. Who can join: by email domain or by invited address

## Context

[Decision 0012](0012-per-workspace-sso.md) ties every workspace to an email domain its Admin proves control of. That fits an organization, but not an individual or a small team without a domain of their own: their people sign in with Gmail or another consumer account, and a public domain such as `gmail.com` can never be owned by one workspace. The install path ([decision 0026](0026-published-images-one-entry-point.md)) has to serve them too.

## Decision

- An instance chooses, once, how people join its workspaces (`SPYRIA_JOIN_BY`): **by email domain** (decision 0012, unchanged) or **by invited address**. Every other part of a workspace is the same; SSO stays required.
- By invited address, a workspace owns no domain. Only an exactly invited address joins: the invitee signs in through the workspace's provider, the address the provider returns must equal the invited one, and the identity is then bound by issuer and subject as everywhere else. Email-first sign-in routes an address with a membership or an open invite; nothing routes by domain. Invites open at once, with no verification link.
- Through Google, consumer accounts are allowed in this setting (no `hd` check). Microsoft consumer accounts stay out: only tenant-specific Entra issuers are accepted, in both settings.
- Wherever an email decides access, Google and generic OIDC providers must confirm it (`email_verified`), in both settings; an unconfirmed address is refused with "Your provider did not confirm this address". Entra keeps its tenant-specific rule.
- A public email domain (Gmail, Outlook and the like) is refused as the domain of a by-email-domain workspace.
- The database refuses an email domain on a workspace joined by invited address, and a change of the setting once anyone else has joined.

## Consequences

- An individual installs Spyria with any Google account or OIDC provider and no domain, no mail, no verification step.
- This reverses decision 0012's "no shared consumer sign-in" for this setting only: access is bounded by the Admin's invites rather than by a domain.
- One setting per instance for now; mixing both, or changing it after creation, is left for later.

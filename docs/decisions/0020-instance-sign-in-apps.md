# 0020. One-click Google and Microsoft sign-in through the apps of the instance

## Context

Setting up sign-in for Google Workspace or Microsoft Entra asked an Admin to register an OAuth client and paste its client id and secret. Google and Microsoft accept only redirect URIs registered in advance, so one app owned by the Spyria project cannot serve self-hosted origins it does not know.

## Decision

- Each deployment may register its own Google OAuth client and its own multi-tenant Microsoft Entra app, once, with its `<origin>/auth/callback`, and set them in the environment (`SPYRIA_GOOGLE_CLIENT_*`, `SPYRIA_MICROSOFT_CLIENT_*`). A hosted Spyria configures the same thing for its own origin.
- When an app is configured, creating a workspace and **Setup SSO** offer it for that provider: no client id or secret to enter. An Admin can still choose their own app.
- Through the Google app, only accounts managed by the Google Workspace of the email domain sign in: the ID token's hosted domain (`hd`) must equal the email's domain.
- Through the Microsoft app, the workspace still gives its tenant id, so the issuer stays tenant-specific as in [0012](0012-per-workspace-sso.md). A Microsoft identity is its object id (`oid`), the same in every app of the tenant, and its address is the user principal name, which Entra keeps on the tenant's verified domains.
- A member is matched by email only until they have an identity at that issuer, and only in a workspace whose domain is verified; changing the issuer of a workspace unverifies its domain.
- The server refuses to start while a workspace uses an app of the deployment that is not configured.
- Extends [0012](0012-per-workspace-sso.md); it does not replace it.

## Alternatives

- A central sign-in relay run by the Spyria project, holding one app per provider for every deployment. It would remove the operator's registration, but every deployment's ID tokens would pass through a third party and sign-in would depend on its availability.

## Consequences

- An operator registers two apps once instead of every Admin registering their own.
- A Microsoft tenant may need an Entra admin to consent to the app on its first sign-in.
- Microsoft without a tenant id (the `organizations` authority, pinning the tenant from the first token) is a possible next step.

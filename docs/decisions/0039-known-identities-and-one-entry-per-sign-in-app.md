# 0039. A known identity signs in without a confirmed address, and one sign-in app is one entry

Amends [decision 0028](0028-generic-oidc-must-confirm-addresses.md) and [decision 0029](0029-account-sign-in-and-workspace-sso.md).

## Context

[Decision 0028](0028-generic-oidc-must-confirm-addresses.md) refuses any sign-in whose provider does not confirm the address (`email_verified`). It was written for the moments when the address decides access: matching an invite or a member by address, routing by a claimed domain, creating a workspace. It also refused people the provider had already identified. A member bound to a provider identity (issuer and subject) was locked out once the provider stopped sending the claim, for example when the person picked another login method at a provider that passes on the claims of the method used, as Cloudflare Access does. The address played no part in recognising them.

Several workspaces can also enforce the same sign-in app (same kind, issuer, client id and use of the deployment's app). The sign-in screen showed one identical entry per workspace, "Continue with your organization's sign-in" twice, and each entry opened only its own workspace.

## Decision

- **A known identity needs no confirmed address.** When the identity is already bound, to a member of the workspace through its provider or to an account, the sign-in is accepted without `email_verified`. The address used afterwards (claimed domains, invites, the session) is the one Spyria keeps for the person, never the token's.
- **Everything else stays as in decision 0028:** binding a new identity by address, accepting an invite, creating a workspace and confirming Setup SSO still need a confirmed address, and are refused with "Your provider did not confirm this address".
- **One entry per sign-in app.** The entries of an address group the enforcing workspaces by sign-in app. Signing in through that entry signs in to each workspace of the app that admits the person, by each workspace's own rules (its bound identities, invites and claimed domains); each session is opened as if through that workspace's own provider, so the safety rule of decision 0029 holds. A sign-in started for one workspace still opens only that workspace.
- **The sign-in window says the outcome in plain words** and stays open when it has lost its link to the app, so a refusal is never silent.

## Consequences

- A provider that confirms addresses only for some login methods no longer locks out members it already knows; it still cannot admit anyone new by address.
- An unconfirmed address in the token changes nothing: not the person's address, not which invites are accepted.
- One sign-in can open several workspaces that share a sign-in app, which is what clicking each identical entry did before.

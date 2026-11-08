# Who can join and sign-in

Spyria signs everyone in through a single sign-on provider: there are no passwords of its own. Who may join a workspace is chosen once per instance, before the first workspace (`spyria setup` asks, or `SPYRIA_JOIN_BY`):

| | By email domain (`domain`) | By invited address (`invited-address`) |
|---|---|---|
| For | An organization with its own domain | An individual or a team without one, or with consumer accounts |
| A workspace owns | One verified email domain, which routes sign-in | No domain |
| Who joins | Invited people, signing in with an address at the domain | Exactly the invited addresses |
| Providers | Google Workspace, Microsoft Entra (one tenant), any OIDC provider, Cloudflare Access | Any Google account (Gmail included), any OIDC provider; Microsoft Entra of one tenant |
| Before inviting | The domain is verified, by a link sent to an address at it, or `spyria verify-domain` without mail | Nothing: invites work at once |

Either way:

- **The first workspace** is created from the setup link that `spyria setup` prints (`spyria setup-link` prints it again while no workspace exists). Without it, a fresh install says it is being set up, so nobody else can claim it before you.
- **Addresses must be confirmed** by the provider: a Google or generic OIDC account whose provider does not confirm its address is refused with "Your provider did not confirm this address". Microsoft personal accounts never sign in.
- **A member is their provider identity** (issuer and subject), matched at each sign-in; changing the address at the provider keeps the account.
- **A public email domain** such as `gmail.com` cannot be the domain of a workspace: an instance for consumer accounts joins by invited address.
- **New workspace** in the app reuses the member's provider and the instance's setting. On an instance joined by invited address, every workspace signs in through the one app of the instance: Admins see it in **Setup SSO** but cannot change it, and an operator changes its client id and secret for every workspace with `spyria sign-in-app`.

The settings of a workspace, invites and roles are in [administration](../features/admin.md#sign-in-and-domain-verification); the reasoning is in [decision 0012](../decisions/0012-per-workspace-sso.md) and [decision 0027](../decisions/0027-join-by-invited-address.md).

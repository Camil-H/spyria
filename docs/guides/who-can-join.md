# Who can join and sign-in

Spyria has no passwords and sends no sign-in codes: everyone signs in through a single sign-on provider.

## Signing in with an account

The operator chooses the deployment's account providers ([install](./install.md), [manual install](./self-hosting.md#account-providers), [clouds](./cloud.md)):

| Provider | Who signs in |
|---|---|
| Google | Any Google account, Gmail included. |
| Microsoft | Work or school accounts of any organization, and personal Microsoft accounts. |
| Another OIDC provider | Its accounts, as long as it confirms their addresses. |

The sign-in screen asks for an email address, then offers:

- the account providers, except to an address at a [claimed domain](#claimed-domains), which gets its organization's provider first;
- the provider of each SSO-enforcing workspace where the address is invited or a member, labelled "Continue with your organization's sign-in", never by workspace name.

Who joins what is decided only once the provider confirms the address.

## Workspaces and invites

- **Anyone signed in with an account can create a workspace**, and belong to as many as they create or are invited to.
- **Create a workspace** (after signing in without one) and **New workspace** (in the app) ask only for a name.
- **New workspace** is not offered to a session opened through a workspace's own provider, nor to an address at a claimed domain.
- **Members join only by invite** to their exact email address. Nobody joins any other way. The invite works at once, and no email is sent: tell the person yourself.

Good to know:

- An account is the provider's identity (issuer and subject; object id for Microsoft). The address binds it only at the person's first sign-in with any account; later address changes at the provider keep the account.
- Another account with the same address, at any provider, is refused: it "already signs in with another account".
- Google and generic OIDC providers must confirm the address, or sign-in is refused with "Your provider did not confirm this address".
- A generic OIDC provider confirms by sending `email_verified: true` in the ID token; if yours does not, add and test a claim mapping that does ([decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)).
- A Microsoft guest from another organization is never matched by address.

## Workspaces enforcing SSO

A workspace can enforce its organization's own provider in **Workspace settings › Single sign-on** ([administration](../features/admin.md#sign-in-and-sso)): Google Workspace, Microsoft Entra of one tenant, or any OIDC provider.

- Only that provider then opens the workspace, for everyone, Admins included. People lose access when their organization account is removed.
- Until the workspace [claims a domain](#claimed-domains), a session opened through its provider opens only that workspace: it cannot open or list the person's other workspaces, or create one.
- Model keys, tool connections, machines and sessions belong to each workspace membership anyway.
- Workspaces created before account sign-in keep their provider, with SSO enforced; their members keep access through their memberships.

## Claimed domains

A workspace enforcing its own provider can claim its organization's email domains.

1. Open **Workspace settings › Single sign-on** › **Domains** and enter the domain.
2. Add the TXT record Spyria shows (`spyria-verify=…`) at that domain with your DNS provider.
3. Click **Check the record**.

The DNS record is the only proof (no email or provider setting counts), so `gmail.com` or `outlook.com` can never be claimed.

Once a domain is claimed:

- **Its addresses sign in only through the claiming workspace's provider.** Account providers refuse them ("signs in through your organization's provider"). Another workspace's provider is offered only where the address was already a member.
- **That provider opens every workspace the address belongs to**, except a workspace enforcing its own provider, which only its own provider opens.
- Workspaces created earlier with those addresses keep running: their members at the domain reach them through the claiming provider, and invites sent before the claim still work.
- **Its addresses cannot create a workspace, and no other workspace can invite them** ("belongs to another workspace of this Spyria").
- An uninvited address signing in through the claiming provider is told it needs an invite from one of its organization workspace's Admins and cannot create a workspace.
- **The claiming workspace signs in only addresses at its claimed domains.** Its members and pending invites at other domains can no longer sign in, and inviting such an address is refused.

Releasing a domain:

- A domain belongs to at most one workspace of the deployment.
- **Release**, stopping SSO or deleting the workspace frees it at once. Sessions the provider opened in other workspaces end, and the addresses sign in with their own accounts again.
- Spyria does not re-check the record: removing it at your DNS provider changes nothing until the claim is released.
- A claim or release that would put your own address outside the claimed domains is refused, so you cannot lock yourself out.

## The first workspace

A fresh deployment shows only that it is being set up, so nobody can claim it before you.

- Create the first workspace from the setup link `spyria setup` prints. `spyria setup-link` prints it again while no workspace exists.
- Its creator signs in with an account provider, or with their organization's provider, which the workspace then enforces.
- Without account providers, people join that workspace by invite through its provider, and nobody can create further workspaces.

The reasoning is in [decision 0029](../decisions/0029-account-sign-in-and-workspace-sso.md), [decision 0035](../decisions/0035-domain-claims.md) for claimed domains, [decision 0012](../decisions/0012-per-workspace-sso.md) for a workspace's own provider and [decision 0020](../decisions/0020-instance-sign-in-apps.md) for the deployment's Google and Microsoft apps.

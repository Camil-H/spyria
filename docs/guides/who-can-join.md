# Who can join and sign-in

Spyria has no passwords and sends no sign-in codes: everyone signs in through a single sign-on provider.

## Signing in with an account

People sign in with an account at a provider the deployment offers. The operator sets these account providers ([install](./install.md), [manual install](./self-hosting.md#account-providers), [clouds](./cloud.md)):

| Provider | Who signs in |
|---|---|
| Google | Any Google account, Gmail included. |
| Microsoft | Work or school accounts of any organization, and personal Microsoft accounts. |
| Another OIDC provider | Its accounts, as long as it confirms their addresses. |

The sign-in screen asks for an email address first. It then shows the account providers of the deployment, plus the provider of each workspace that enforces SSO and where that address is invited or a member, labelled only by kind ("Continue with your organization's sign-in"), never by workspace name. An address at a [claimed domain](#claimed-domains) is offered no account provider: its organization's provider comes first. Who joins what is decided only once the provider confirms the address.

## Workspaces and invites

- **Anyone signed in with an account can create a workspace**, and belong to as many as they create or are invited to; a workspace of one member is the personal case. After signing in without any workspace, **Create a workspace** asks only for a name, and **New workspace** in the app works the same way. **New workspace** is not offered to a session opened through a workspace's own provider, nor to an address at a claimed domain.
- **Members join only by invite** to their exact email address. An invite works at once, and no email is sent: tell the person yourself. Nobody joins a workspace any other way.
- **An account is the provider's identity** (issuer and subject; the object id for Microsoft), never the address alone. The address binds an account only at the first sign-in of that person with any account; afterwards the address may change at the provider and the account stays. Any other account carrying the same address, at the same provider or another, is refused: it "already signs in with another account".
- **Addresses must be confirmed** by Google and by generic OIDC providers; otherwise sign-in is refused with "Your provider did not confirm this address". A generic OIDC provider confirms an address by sending `email_verified: true` in the ID token; if yours does not, add a claim mapping that does, and check it before relying on it ([decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)). A Microsoft guest from another organization is never matched by address.

## Workspaces enforcing SSO

A workspace can enforce its organization's own provider in **Workspace settings › Single sign-on** ([administration](../features/admin.md#sign-in-and-sso)): Google Workspace, Microsoft Entra of one tenant, or any OIDC provider. Then only that provider opens the workspace, for everyone, Admins included, so people lose access when their organization account is removed.

Until the workspace [claims a domain](#claimed-domains), a session opened through its own provider opens only that workspace: it cannot open or list the person's other workspaces, or create a workspace. Model keys, tool connections, machines and sessions belong to each workspace membership anyway.

Workspaces created before account sign-in keep their provider, with SSO enforced; their members keep access through their memberships.

## Claimed domains

A workspace that enforces its own provider can claim its organization's email domains in **Workspace settings › Single sign-on** › **Domains**: enter the domain, add the TXT record Spyria shows (`spyria-verify=…`) at that domain with your DNS provider, then **Check the record**. The DNS record is the only proof: no email and no setting of the provider counts. Nobody can add a record to `gmail.com` or `outlook.com`, so such domains always stay open to everyone.

Once a domain is claimed:

- **Its addresses sign in only through the claiming workspace's provider.** Account providers refuse them ("signs in through your organization's provider"), and a provider of any other workspace is offered only where the address was already a member.
- **That provider opens every workspace the address belongs to**, except a workspace enforcing a provider of its own, which only its own provider opens. Workspaces created earlier with those addresses keep running: their members at the domain reach them through the claiming workspace's provider, and invites sent before the claim still work.
- **Its addresses cannot create a workspace**, and **no other workspace can invite them** ("belongs to another workspace of this Spyria").
- **The claiming workspace signs in only addresses at its claimed domains**: its members and pending invites at any other domain can no longer sign in, and inviting such an address is refused.

A domain belongs to at most one workspace of the deployment. **Release** frees it at once, and so do stopping SSO and deleting the workspace: the sessions the provider opened in other workspaces end, and the addresses sign in with their own accounts again. Spyria does not check the record again by itself, so removing the record at your DNS provider changes nothing until the claim is released. A claim or release that would put your own address outside the workspace's claimed domains is refused, so that you cannot lock yourself out.

## The first workspace

A fresh deployment shows only that it is being set up, so nobody can claim it before you. Its first workspace is created from the setup link that `spyria setup` prints (`spyria setup-link` prints it again while no workspace exists). Its creator signs in with an account provider, or with their organization's provider, which the workspace then enforces. Without account providers, people join that workspace by invite through its provider, and nobody can create further workspaces.

The reasoning is in [decision 0029](../decisions/0029-account-sign-in-and-workspace-sso.md) and, for claimed domains, [decision 0035](../decisions/0035-domain-claims.md), with [decision 0012](../decisions/0012-per-workspace-sso.md) for a workspace's own provider and [decision 0020](../decisions/0020-instance-sign-in-apps.md) for the deployment's Google and Microsoft apps.

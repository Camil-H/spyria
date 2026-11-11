# Who can join and sign-in

Spyria has no passwords and sends no sign-in codes: everyone signs in through a single sign-on provider.

## Signing in with an account

People sign in with an account at a provider the deployment offers. The operator sets these account providers ([install](./install.md), [manual install](./self-hosting.md#account-providers), [clouds](./cloud.md)):

| Provider | Who signs in |
|---|---|
| Google | Any Google account, Gmail included. |
| Microsoft | Work or school accounts of any organization, and personal Microsoft accounts. |
| Another OIDC provider | Its accounts, as long as it confirms their addresses. |

The sign-in screen asks for an email address first. It then shows the account providers of the deployment, plus the provider of each workspace that enforces SSO and where that address is invited or a member, labelled only by kind ("Continue with your organization's sign-in"), never by workspace name. Who joins what is decided only once the provider confirms the address.

## Workspaces and invites

- **Anyone signed in with an account can create a workspace**; a workspace of one member is the personal case. After signing in without any workspace, **Create a workspace** asks only for a name, and **New workspace** in the app works the same way.
- **Members join only by invite** to their exact email address. An invite works at once, and no email is sent: tell the person yourself. Nobody joins a workspace any other way.
- **An account is the provider's identity** (issuer and subject; the object id for Microsoft), never the address alone. The address binds an account only at the first sign-in of that person with any account; afterwards the address may change at the provider and the account stays. Any other account carrying the same address, at the same provider or another, is refused: it "already signs in with another account".
- **Addresses must be confirmed** by Google and by generic OIDC providers; otherwise sign-in is refused with "Your provider did not confirm this address". A generic OIDC provider confirms an address by sending `email_verified: true` in the ID token; if yours does not, add a claim mapping that does, and check it before relying on it ([decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)). A Microsoft guest from another organization is never matched by address.

## Workspaces enforcing SSO

A workspace can enforce its organization's own provider in **Workspace settings › Setup SSO** ([administration](../features/admin.md#sign-in-and-sso)): Google Workspace, Microsoft Entra of one tenant, or any OIDC provider. Then only that provider opens the workspace, for everyone, Admins included, so people lose access when their organization account is removed.

A session opened through a workspace's own provider opens only that workspace: it cannot open or list the person's other workspaces, or create a workspace. Model keys, tool connections, machines and sessions belong to each workspace membership anyway.

Workspaces created before account sign-in keep their provider, with SSO enforced; their members keep access through their memberships.

## The first workspace

A fresh deployment shows only that it is being set up, so nobody can claim it before you. Its first workspace is created from the setup link that `spyria setup` prints (`spyria setup-link` prints it again while no workspace exists). Its creator signs in with an account provider, or with their organization's provider, which the workspace then enforces. Without account providers, people join that workspace by invite through its provider, and nobody can create further workspaces.

The reasoning is in [decision 0029](../decisions/0029-account-sign-in-and-workspace-sso.md), with [decision 0012](../decisions/0012-per-workspace-sso.md) for a workspace's own provider and [decision 0020](../decisions/0020-instance-sign-in-apps.md) for the deployment's Google and Microsoft apps.

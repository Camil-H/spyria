# Who can join and sign-in

Spyria has no passwords and sends no sign-in codes: everyone signs in through a single sign-on provider, at two levels.

- **Account providers** allow members to sign in to Spyria with their own account, create workspaces and join the ones they are invited to.
- **A workspace's own provider** can be enforced so all members of that workspace, Admins included, must sign in with that provider (Microsoft Entra, Google Workspace, any OIDC provider such as Okta or Cloudflare Access).

## Signing in with an account

Account providers are set when installing Spyria ([install](./install.md), [manual install](./self-hosting.md#account-providers), clouds: [AWS](./cloud-aws.md), [Azure](./cloud-azure.md), [Google Cloud](./cloud-gcp.md)):

| Provider | Who signs in |
|---|---|
| Google | Any Google account, Gmail included. |
| Microsoft | Work or school accounts of any organization, and personal Microsoft accounts. |
| Another OIDC provider | Its accounts, as long as it confirms their addresses. |

The sign-in screen asks for an email address, then offers the account providers, and "Continue with your organization's sign-in" for each workspace enforcing SSO where the address is invited or a member. An address at a [claimed domain](#good-to-know) is offered no account provider: its organization's sign-in comes first.

## Workspaces and invites

- **Anyone signed in with an account can create a workspace**, and belong to as many as they create or are invited to.
- **New workspace** creation is not offered to a session opened through a workspace's own provider, nor to an address at a claimed domain.
- **Members join only by invite** to their exact email address. Nobody joins any other way. The invite works at once, and no email is sent: tell the person yourself.
- Another account with the same address, at any provider, is refused: it "already signs in with another account".
- Google and generic OIDC providers must confirm the address, or sign-in is refused with "Your provider did not confirm this address".

## Good to know

- **A workspace can enforce its own provider**, in **Create a workspace** or **Workspace settings › Single sign-on** ([administration](../features/admin.md#sign-in-and-sso)). Only that provider then opens the workspace, for everyone, Admins included, and people lose access when their organization account is removed.
- **A workspace enforcing its provider can claim its organization's email domains** with a DNS record ([domains](../features/admin.md#domains)). The domain's addresses then sign in only through that provider, cannot create workspaces, and cannot be invited to other workspaces of this Spyria.
- **Workspaces created before a domain claim keep running.** Their members at the domain reach them through the claiming workspace's provider, and invites sent before the claim still work. Releasing the domain lets those addresses sign in with their own accounts again.

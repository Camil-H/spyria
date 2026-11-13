# 0035. A workspace may claim its organization's email domains

Amends [decision 0029](0029-account-sign-in-and-workspace-sso.md) (its safety rule and "no domain claim") and the parts of [decision 0012](0012-per-workspace-sso.md) it kept: a workspace may own an email domain again, proven by DNS only.

## Context

Decision 0029 made a workspace's own provider open only that workspace: its Admin chooses the provider, so a provider that asserts any address could otherwise sign in as anyone, into every workspace of that address. The price is that a person who signs in through their organization's provider cannot create a workspace, and on a deployment without account providers nobody creates a second workspace at all.

What makes a provider safe for more than its own workspace is proof that the organization owns the addresses it asserts. Instance and workspace also stay separate concepts: a hosted offering, or an operator running several organizations' workspaces, serves organizations that own their domain and people who own none.

## Decision

- **Claiming.** A workspace that enforces its own provider may claim email domains. An Admin with **Setup SSO** enters a domain, Spyria shows a TXT record (`spyria-verify=<token>`) to add at that domain, and the claim holds once Spyria finds the record. DNS is the only proof: no email, no provider shortcut. A domain belongs to at most one workspace of the instance; while it is free, several workspaces may hold a pending claim, and the first whose record is found gets it. No list of consumer domains is kept: nobody can add a record to `gmail.com`.
- **Releasing.** An Admin removes a claim; stopping the workspace's SSO and deleting the workspace release all its claims. Spyria does not check the record again on its own: a DNS outage must not lock an organization out. An Admin's change is refused when their own address would end up outside the workspace's claimed domains.
- **Trust.** A workspace's own provider is trusted for the addresses at the domains its workspace claimed, and only for those:
  - Through a trusted provider, a session can open every workspace the address is a member of, except a workspace enforcing a provider of its own, which only that provider opens.
  - Once a workspace claims a domain, its provider refuses every address outside its claimed domains, members included.
  - A workspace enforcing its provider without any claim keeps 0029's rule: its provider opens that workspace only.
- **A claimed domain is one workspace.** An address at a claimed domain signs in only through the claiming workspace's provider: account providers refuse it, and sign-in offers that provider, plus the provider of any other workspace enforcing SSO where the address is already a member. It cannot create a workspace, and no other workspace can invite it (no guests for now).
- **Unclaimed domains are many workspaces.** Anyone signed in with an account creates workspaces freely and can be a member of several, as creator or invitee.
- **Existing workspaces** are left alone when a domain is claimed: memberships stay, members at the domain reach the workspaces that do not enforce SSO through the claiming workspace's provider, and a workspace enforcing its own provider keeps opening for its members through it. Open invites stay valid; only new creation and new invites are refused.
- **Storage.** `domain_claims` carries `workspace_id` and references the workspace's SSO settings; a session records the workspace whose provider opened it (none for an account), and one SQL function, `provider_opens_workspace`, decides on every session and invite whether that provider opens a workspace for that address.

## Alternatives

- **Re-check the TXT record on a schedule.** It would free a domain whose owner changed without anyone acting, but a resolver failure or a mistaken DNS change would sign out a whole organization. Left for later, with a grace period, if a case calls for it.
- **A list of consumer domains.** Unnecessary: a domain stays free until someone proves they own it.
- **Prove a domain by an emailed link or by the provider's tenant.** An email proves one mailbox, not the domain; a provider's tenant or hosted domain is configured by the very Admin it would vouch for.

## Consequences

- An organization's people get one sign-in for their workspaces, and an organization knows its addresses cannot appear in another workspace on the instance.
- Typing an address at a claimed domain shows that it is claimed, through the single provider offered; the TXT record is public anyway.
- A workspace that claims a domain loses its members at other domains, and its pending invites to them; the claim screen says so.
- On a deployment without account providers, people at unclaimed domains still cannot create workspaces, since only account sign-in creates one.

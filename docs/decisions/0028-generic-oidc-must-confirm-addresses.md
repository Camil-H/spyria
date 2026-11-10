# 0028. A generic OIDC provider must confirm the address it returns

## Context

[Decision 0027](0027-join-by-invited-address.md) requires Google and generic OIDC providers to send `email_verified: true` wherever an email decides access. For a workspace joined by email domain, the address is what lets a person in: without the claim, anyone able to set an unconfirmed address at that domain on the provider (self-registration, a profile field users edit) could join the workspace. Some providers never send the claim, and their members are then refused with "Your provider did not confirm this address".

The alternatives considered:

- **Let an Admin mark the workspace's provider as trusted for addresses**, so the claim is not required. It adds a setting whose safety depends on how the provider is configured, something Spyria cannot check, and an Admin who turns it on to get past the refusal re-opens the hole for every member.
- **Accept a missing claim when the provider is the workspace's own SSO.** A generic OIDC provider always is the workspace's own (instance apps are Google and Microsoft only), so this amounts to dropping the check for generic OIDC: a provider that lets people set their address and stays silent about it would admit them.

## Decision

- Keep the rule strict: a generic OIDC provider must send `email_verified: true`; a missing or false claim is refused, by email domain and by invited address alike. There is no per-workspace exception.
- The documentation says what to configure: providers that confirm addresses send the claim already; one that does not needs a claim mapping that sends `email_verified: true` for the addresses its directory manages.

## Consequences

- An address a provider does not vouch for never decides access.
- For the first workspace, a provider without the claim is found at once: its creator's own sign-in is refused with the same message, before anyone joins. An Admin who later switches a workspace to such a provider in **Setup SSO** locks every member out until the provider sends the claim, so the documentation asks to check it before switching.
- A provider that cannot send the claim at all cannot be used as a generic OIDC provider; its organization signs in through Google, Microsoft Entra or another provider in front of it.

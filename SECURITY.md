# Security

## Reporting a vulnerability

Email **camil@spyria.dev**. Do not open a public issue, pull request or discussion for it.

Say what you found, the version or commit, the steps or a proof of concept that shows it, and what an attacker gains. You get an answer, then news as the fix progresses, and credit in the release notes unless you would rather not.

Please test only on an instance of your own, and do not read, change or delete other people's data.

Every Spyria serves this contact at `/.well-known/security.txt`, since its code is ours, whoever runs it. When a report turns out to be about one organization's setup rather than the code, we say so, and you take it to that organization.

## Supported versions

Fixes go into the latest release. Upgrade with `spyria upgrade`; `spyria doctor` also points out an install whose `.env` other users can read, a default or short credential, or a port published beyond the machine.

## Scope

The code in this repository: the server, the web app, the runtime host and agent images, the `spyria` tool, the Compose files and the OpenTofu modules. A problem in how one organization runs its own Spyria goes to that organization; a problem in a dependency goes to its project, though we want to hear when Spyria exposes it.

How Spyria protects workspaces is described in [docs/architecture/security.md](docs/architecture/security.md).

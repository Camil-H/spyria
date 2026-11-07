# Spyria documentation

Start with the architecture overview, then the page for what you are doing. The project rules for contributors are in [AGENTS.md](../AGENTS.md).

## Architecture

- [Overview](architecture/overview.md): the system in one diagram, the life of an agent turn, why tokens stream outside Zero, where state lives.
- [Contexts and apps](architecture/contexts.md): what each package and app owns, its entries, and how contexts talk.
- [Security](architecture/security.md): sign-in, workspace scoping, permissions and roles, credentials, rate limits, secrets and logging.

## Decisions

- [Decision records](decisions/README.md): one short record per architectural decision, with its context and consequences.

## Guides

- [Development](guides/development.md): prerequisites, the dev stack, `.env.dev`, daily commands, a local runtime host, the project layout.
- [Testing](guides/testing.md): the test layers, commands, fakes, e2e conventions, the looks, the docker suite, manual checks.
- [Install on one machine](guides/install.md): `install.sh` and `spyria setup`: the tunnel, who can join, the provider and mail, the runtime host on the machine.
- [Manual install](guides/self-hosting.md): what `spyria setup` does underneath: requirements, `.env.prod`, Compose profiles, the first workspace, runtime hosts, the GitHub App, a Cloudflare example.
- [Install on AWS, Azure or Google Cloud](guides/cloud.md): the OpenTofu modules of the managed control plane and the runtime host VMs, and `spyria setup --cloud`.
- [Operations](guides/operations.md): upgrades and backups with `spyria`, logs, traces, health, jobs, connections, disk.
- [Who can join and sign-in](guides/who-can-join.md): by email domain or by invited address, the setup link, confirmed addresses.
- [Troubleshooting](guides/troubleshooting.md): `spyria doctor` and the symptoms that cost the most time.

## Features

- [Chats and sharing](features/chats-and-sharing.md): projects, channels, threads, unread state, chat roles, forks, runtimes from a thread.
- [Agents](features/agents.md): harnesses, models and routing, effort, questions, opening pages, delegation, steps, Stop, budgets for a member.
- [Machines](features/machines.md): workspace runtime hosts, a member's own machine, harness install, where a chat runs.
- [Dev mode](features/dev-mode.md): repositories, dev chats, the setup script, the side panel, git actions, pull requests, quality gates, webhooks.
- [Administration](features/admin.md): members and invites, roles, SSO, GitHub, shared tools, spend, budgets, the audit log.

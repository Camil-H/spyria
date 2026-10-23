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
- [Testing](guides/testing.md): the test layers, commands, fakes, e2e conventions, the visual and docker suites, manual checks.
- [Self-hosting](guides/self-hosting.md): requirements, `.env.prod`, Compose profiles, the first workspace, runtime hosts, the GitHub App, a Cloudflare example, pitfalls.
- [Operations](guides/operations.md): logs, traces, health, upgrades, jobs, connections, disk, backups.

## Features

- [Chats and sharing](features/chats-and-sharing.md): projects, channels, threads, unread state, chat roles, forks, runtimes from a thread.
- [Agents](features/agents.md): harnesses, models and routing, effort, plan mode, questions, delegation, steps, Stop, budgets for a member.
- [Machines](features/machines.md): workspace runtime hosts, a member's own machine, harness install, where a chat runs.
- [Dev mode](features/dev-mode.md): repositories, dev chats, the setup script, the side panel, git actions, pull requests, webhooks.
- [Administration](features/admin.md): members and invites, roles, SSO, GitHub, shared tools, spend, budgets, the audit log.

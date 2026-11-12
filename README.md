# Spyria

An organization-agnostic, model-agnostic AI workspace. Members and agents work together in chats and channels; agents run in sandboxed runtimes on the organization's own machines, using each member's own model keys, or on a member's own machine with their Claude or ChatGPT subscription. Dev chats work on GitHub repositories and end in pull requests. Admins manage members, roles, single sign-on, shared tools, budgets and the audit log.

Spyria is self-hosted with one Docker Compose file.

## Quickstart

Development (Bun 1.4.4, Node 24 and Docker):

```sh
bun install
bun run db:migrate
bun run db:seed
bun run dev           # the app on http://localhost:5173; sign in as alice@example.com, password "password"
```

Self-hosting on one machine with a domain on Cloudflare (Docker, an OIDC provider or any Google account; mail optional):

```sh
curl -fsSL https://spyria.dev/install | sh
```

or, the same script straight from the latest release: `curl -fsSL https://github.com/Camil-H/spyria/releases/latest/download/install.sh | sh`.

Then open the setup link it prints and create the first workspace. The steps are in [install on one machine](docs/guides/install.md); managed clouds in [install on AWS, Azure or Google Cloud](docs/guides/cloud.md), and the [manual install](docs/guides/self-hosting.md).

## Documentation

- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture/overview.md), [contexts](docs/architecture/contexts.md), [security](docs/architecture/security.md)
- [Decision records](docs/decisions/)
- Guides: [development](docs/guides/development.md), [testing](docs/guides/testing.md), [install on one machine](docs/guides/install.md), [AWS, Azure or Google Cloud](docs/guides/cloud.md), [manual install](docs/guides/self-hosting.md), [operations](docs/guides/operations.md), [troubleshooting](docs/guides/troubleshooting.md)
- Features: [chats and sharing](docs/features/chats-and-sharing.md), [agents](docs/features/agents.md), [machines](docs/features/machines.md), [dev mode](docs/features/dev-mode.md), [administration](docs/features/admin.md)
- Contributing: [AGENTS.md](AGENTS.md) (project rules, for people and coding agents) and [CONTRIBUTING.md](CONTRIBUTING.md)
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## License

Spyria is licensed under the [Business Source License 1.1](LICENSE). Production use is free for an organization with up to 10 members, as long as Spyria is not offered as a competing hosted service; each version converts to the Apache License 2.0 two years after its release. Contributions require the [Contributor License Agreement](CLA.md). See [decision 0019](docs/decisions/0019-business-source-license.md).

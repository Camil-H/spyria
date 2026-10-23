# 0018. Tests run on their own Postgres, with fakes for everything external

## Context

Integration and end-to-end tests need a real database, a real gateway and real sign-in flows to be worth anything. Sharing the developer's stack would let tests destroy local data and let local data change test results. Calling real providers would cost money, need secrets in CI and fail for reasons unrelated to the change.

## Decision

- Tests start and own their containers, named `spyria-test-*`: an in-memory Postgres on its own port, a test Dex, and test gateways. They never touch the development stack.
- Integration tests each get a fresh database cloned from a migrated template; e2e runs one database, zero-cache and fake runtime host per worker.
- No test calls a real model, identity provider, GitHub or npm. Fakes live in `apps/server/src/testing/` (a scripted LLM, an OAuth-protected MCP server, GitHub, SMTP, an npm registry, a runtime host driving a real `spyria-agent`). Production code cannot import them.
- Each run removes what killed runs left behind and keeps the reusable fixtures.

## Consequences

- Tests are safe to run at any time, in parallel, without secrets.
- Behaviour that needs a real subscription or a real provider is listed as manual checks.
- Fakes must follow the real contracts closely; for example the fake GitHub enforces token permissions as GitHub does.

See [testing](../guides/testing.md).

# Contributing

Spyria is licensed under the Business Source License 1.1 (see `LICENSE`).

## Contributor License Agreement

A pull request is merged only after its author has agreed to the [Contributor License Agreement](CLA.md). For now you sign it by adding the statement at the end of `CLA.md` to your pull request description.

## Tests

Every change comes with tests in the right layer:

- **Unit**: pure logic, next to the code. `bun run test`
- **Integration**: server contracts against a real Postgres (`*.integration.test.ts`). `bun run test:integration` (it starts its own test Postgres, gateway and Dex)
- **e2e**: user stories in the browser, under `apps/web/e2e` (one file per area, titles "As <role>, I …"). `bun run test:e2e`, or `bun run test:e2e:smoke` for the critical paths

A pull request that changes the UI includes screenshots in light and dark; the reviewer judges the looks from them.

Pull requests target `develop`; CI runs the checks and the tests your change affects, and `main` only receives commits of `develop` that passed the full suite.

While iterating, `bun run check:related` runs lint, typecheck, boundaries and the affected tests. Before opening a pull request, `bun run check:all` runs everything. See [docs/guides/testing.md](docs/guides/testing.md) for details.

# Contributing

Spyria is licensed under the Business Source License 1.1 (see `LICENSE`).

## Contributor License Agreement

A pull request is merged only after its author has agreed to the [Contributor License Agreement](CLA.md). For now you sign it by adding the statement at the end of `CLA.md` to your pull request description.

## Tests

Every change comes with tests in the right layer:

- **Unit**: pure logic, next to the code. `bun run test`
- **Integration**: server contracts against a real Postgres (`*.integration.test.ts`). `bun run stack:up`, then `bun run test:integration`
- **e2e**: user stories in the browser, under `apps/web/e2e` (one file per area, titles "As <role>, I …"). `bun run test:e2e`, or `bun run test:e2e:smoke` for the critical paths
- **ui**: screenshots light and dark under `apps/web/ui`. `bun run test:ui`; after an intended design change, `bun run test:ui:update` and review the changed PNGs

While iterating, `bun run check:related` runs lint, typecheck, boundaries and the affected tests. Before opening a pull request, `bun run check:all` runs everything. See the README's Checks section for details.

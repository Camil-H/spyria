# 0019. Business Source License with a member threshold

## Context

Spyria is meant to be read, run and improved by anyone, and small teams should be able to use it in production for free. At the same time, the project needs a way to fund itself and should not be resold as a competing hosted service.

## Decision

- Spyria is licensed under the Business Source License 1.1 (see [`LICENSE`](../../LICENSE)).
- Additional Use Grant: production use is allowed for an organization with no more than 10 members across its workspaces, provided Spyria is not offered to third parties as a hosted or managed service that competes with the licensor's paid offerings.
- Each version converts to the Apache License 2.0 on the second anniversary of its first public release.
- Contributions are accepted after the author agrees to the [Contributor License Agreement](../../CLA.md).

## Consequences

- Anyone can read, modify and run Spyria for non-production use, and small organizations can run it in production.
- Larger organizations need another licensing arrangement until a version converts.
- The CLA lets the project relicense contributions, including under the Apache License when versions convert.
- Spyria is not "open source" in the OSI sense until a version converts.

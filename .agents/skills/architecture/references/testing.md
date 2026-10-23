# Testing

Rule group `T`. Controls are in [`../standard.md`](../standard.md).

**T1a** Every collaborator has its own tests, because testing only the application layer leaves the
integration surface unverified.

**T1b** A transport fake belongs only where the transport, parser, or vendor client is tested.

**T2a** A unit is tested against stubbed collaborators for success, empty, edge, and failure cases.

**T2b** Substitution happens by passing a fake through the contract, never by patching an import.

**T3** Integration tests run against real dependencies in containers, not fakes, because a fake
cannot exhibit isolation anomalies, constraint races, lock ordering, or partial failure.

**T4** A fake is published only when another context consumes it, runs the same conformance suite as
the real implementation in one parametrized session, and is never published for a contract with
transactional or ordering semantics.

**T5** A published surface is verified from the consumer side, and the provider verifies against
recorded consumer expectations.

**T6a** Coverage is measured as branch coverage.

**T6b** Mutation testing on `domain/` and `operations/` substantiates any claim that every error
branch is exercised.

**T7** A stateful contract is tested with a property-based state machine that explores
interleavings, not fixed scripts.

**T8** Deprecated: retired, kept so existing citations stay valid.

**T9a** Input matrices are parametrized, with counts derived from the variable under test and never
from a hardcoded literal.

**T9b** Where a function composes a request, the composed request is asserted, not only the return
value.

**T10** A bounded set of critical journeys runs through a real entrypoint against containerized
dependencies, crossing context boundaries as production does. It proves the system is wired, not
that logic is correct, and an end-to-end suite that grows into a regression net becomes slow, then
flaky, then disabled.

**T11** An intermittent failure is quarantined with a named owner and a deadline, its subject is
treated as suspect until diagnosed, and an automatic retry never masks it.


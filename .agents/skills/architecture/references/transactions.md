# Transactions and consistency

Rule group `TX`. Controls are in [`../standard.md`](../standard.md).

**TX1a** An operation owns its transaction boundary and receives an opaque unit-of-work handle.

**TX1b** Repositories are resolved from that handle, never constructed independently, so everything
in one operation commits or rolls back together.

**TX2** A nested transaction uses a savepoint with stated semantics, because a partial rollback that
leaves an operation half-applied is a defect.

**TX3** A cross-context state change and its outbox row commit together, and a separate relay
publishes it. Distributed transactions across services are not used.

**TX4** A multi-step flow spanning contexts has an explicit compensating action for every step, and
the compensation is tested.

**TX5a** Every externally triggered write carries an idempotency key with a stated dedup window.

**TX5b** A consumer is an idempotent handler, because at-least-once delivery is assumed and
exactly-once is not available.

**TX6** A contract states its ordering guarantee, and a handler that requires ordering declares its
partition key.

**TX7** Every consumer has a retry bound, a dead-letter destination, and an operator path to replay
after repair.


# Resilience

Rule group `RS`. Controls are in [`../standard.md`](../standard.md).

**RS1** A retry policy belongs to the operation, not to the dependency.

**RS2** A non-idempotent operation is retried only with an idempotency key.

**RS3** Backoff is exponential with full jitter and a cap.

**RS4** Every dependency has a client-level retry budget, throttled as a fraction of successful
traffic.

**RS5** A deadline is set at the entrypoint, propagated with the call, and never exceeded by a retry
or an attempt.

**RS6** Every network client has a connect timeout, a read timeout, a bounded connection pool, and a
maximum payload size.

**RS7** Every dependency sits behind a circuit breaker with stated trip and recovery conditions, and
the breaker's state is observable.

**RS8** A store-level serialization or deadlock failure is retried around the whole operation, with
a bounded attempt count, because the transaction boundary is what must be retried.


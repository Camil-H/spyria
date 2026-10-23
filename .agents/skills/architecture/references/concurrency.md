# Concurrency

Rule group `AS`. Controls are in [`../standard.md`](../standard.md).

**AS1** No blocking I/O on the event loop: a blocking call is dispatched to a thread or an explicit
executor.

**AS2** Concurrent work uses structured concurrency, and no task is fire-and-forget: every task is
awaited or explicitly supervised with a stated failure policy.

**AS3** Scoped state propagates through async-local context, never through globals or thread-locals.

**AS4** A contract is sync or async, not both; where both are needed the async form is canonical and
the sync form is a thin documented wrapper.

**AS5** Shared mutable state across tasks or threads declares its synchronization, and an object
documented as not thread-safe is confined to one task.

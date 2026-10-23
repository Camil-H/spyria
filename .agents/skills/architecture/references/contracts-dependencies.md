# Contracts and dependency injection

Rule group `C`. Principles are in [`../SKILL.md`](../SKILL.md); controls are in
[`../standard.md`](../standard.md).

**C1** A collaborator contract is an interface declared in `contracts/`.

**C2a** An interface declares a seam the consumer needs; an abstract base class is only for a hierarchy you own and
share behaviour through.

**C2b** A runtime interface check is never an authorization or dispatch mechanism: it checks method names
only, not signatures.

**C3** Every implementation carries a static conformance assertion in a type-checked module, so a
drifted implementation fails the type gate rather than only failing at the wiring site.

**C4** Dependencies arrive as parameters: no module-level mutable state, no service locator, no
ambient registry lookup inside an operation.

**C5a** The composition root constructs the object graph, and no context imports it. Where a
process hosts exactly one context, that context's `entrypoints/` may be the composition root.

**C5b** Only the composition root and a context's dependency providers name a concrete
implementation.

**C6a** Every injected object declares a scope: per-process — which means one per instance, not one per
system — per-request, or per-task.

**C6b** Scoped objects are created by a scope factory, carried in async-local context where implicit
propagation is required, and torn down in reverse construction order on both success and failure.

**C7** Importing a module performs no I/O, opens no connection, reads no configuration, and starts
no thread.

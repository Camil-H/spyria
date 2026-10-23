# Layering

Rule group `L`. Principles are in [`../SKILL.md`](../SKILL.md); controls are in
[`../standard.md`](../standard.md).

**L1** A context's layers are the sub-packages named in its layers contract, and the contract is
exhaustive so no sub-package is unnamed.

**L2** Direction decides the layer: what drives the system is an entrypoint, what the system calls
out to is an integration.

**L3a** Imports within a context follow the layer table.

| Layer | May import |
|---|---|
| `domain/` | standard library, `kernel` |
| `contracts/` | `domain`, `kernel` |
| `operations/` | `contracts`, `domain`, `kernel` |
| `queries/` | `domain`, `kernel`, its own storage driver |
| `integrations/` | `contracts`, `domain`, `kernel` |
| `entrypoints/`, route modules | every layer except `integrations` |
| `entrypoints/`, dependency providers | every layer |

A context's error and constant modules sit below every layer, and any layer may import them.

**L3b** `integrations/`, `operations/` and `queries/` are siblings, and none may import another.

**L4** `domain/` imports no third-party package, and `kernel/` imports nothing at all
beyond the standard library and itself — its package manifest declares no dependencies.

**L5** A vendor or infrastructure SDK appears only under `integrations/`, `queries/` or
`entrypoints/`.

**L6** Contract signatures speak only `domain`, `kernel` and standard-library types, apart from the opaque
unit-of-work handle of `TX1a`.

**L7a** Business logic lives in `operations/` and `domain/`, never in `entrypoints/` or
`integrations/`.

**L7b** A context's `entrypoints/` holds its own wiring, transport and serialization; mechanics
shared across contexts live in a shared package, which is not a layer.

**L8** No import cycles between modules, at any layer.

**L9a** The read path is `entrypoints/ → queries/`, bypassing `operations/`.

**L9b** A query returns a frozen shape declared in `queries/`, never a domain entity, and may
contain hand-written SQL.

**L9c** The read path is concrete: no contract stands over it until a second implementation exists.

**L10a** An operation's deciding reads go through a repository contract inside its own transaction,
because a read the operation cannot trust is stale before the write commits.

**L10b** `operations/` may not import `queries/`.

**L11** Bulk and streaming access are declared contract shapes, not loops over a single-entity
method: a batch method takes and returns collections, a stream returns an async sequence with
stated back-pressure, and a paged method takes and returns an opaque cursor.


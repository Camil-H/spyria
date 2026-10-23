# Boundaries between contexts

Rule group `B`. Principles are in [`../SKILL.md`](../SKILL.md); controls are in
[`../standard.md`](../standard.md).

**B1** A context exposes one published surface; everything else is internal.

**B2** No context imports another's internals.

**B3** A published surface is documented where it is published, not inferred by consumers from
source.

**B4a** An incompatible change to a surface with independent consumers ships a new version
alongside the old, with a stated sunset date and notice to known consumers.

**B4b** Incompatibility is detected mechanically, not by author self-classification.

**B5a** The packages a context may import from outside it form the shared layer (for example `kernel`
and a database package), a closed set that grows only by decision; each shared package states which
layers may import it.



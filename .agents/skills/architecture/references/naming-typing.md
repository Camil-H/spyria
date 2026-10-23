# Naming and typing

Rule group `N`. Controls are in [`../standard.md`](../standard.md).

**N1** Every public signature is annotated, including returns, and says what it actually accepts.

**N2** The type checker runs in strict mode with a pinned configuration: untyped definitions
rejected, returns of `Any` warned, suppressions carrying an explicit error code, and no blanket
ignores.

**N3** `Any` has a per-package budget that only ratchets downward.

**N4** A name states what the function does and what it returns, and is renamed when behaviour
drifts from it.

**N5** One verb has one meaning within a layer.

**N6** A domain concept has one name, used identically in code, logs, and the
glossary.

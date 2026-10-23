# Configuration and flags

Rule group `G`. Controls are in [`../standard.md`](../standard.md).

**G1** Deprecated: retired, kept so existing citations stay valid.

**G2** Configuration is read once, in the composition root, and passed inward as values.

**G3** A config-derived identifier is looked up from a provided map, never written at the use site.

**G4a** A credential is carried by a redacting type, per `V6`.

**G4b** A credential comes from a secrets manager, not from the environment.

**G4c** Every credential has a stated rotation interval.

**G5** A runtime-mutable flag arrives through an injected contract, like any other dependency.

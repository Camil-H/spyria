# Values and primitives

Rule group `V`. Controls are in [`../standard.md`](../standard.md).

**V1** Every datetime is timezone-aware and UTC; local time exists only for display.

**V2** A duration comes from a monotonic clock, never from subtracting wall-clock readings.

**V3** Each kind of identifier is its own type, so two cannot be passed in each other's place.

**V4a** A domain value object is immutable.

**V4b** A value object with an invariant checks it on construction, so holding the type proves the
invariant.

**V5a** Money is an exact decimal type, never binary floating point, and never mixed with it in one expression.

**V5b** A monetary value carries its currency and refuses arithmetic with a different one.

**V5c** Scale and rounding come from one named policy, applied in one place.

**V6** A value that must not appear in a log redacts itself when converted to text.


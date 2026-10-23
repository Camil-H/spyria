# Errors

Rule group `E`. Controls are in [`../standard.md`](../standard.md).

**E1a** Each context defines a typed exception hierarchy whose base carries a stable
machine-readable code.

**E1b** An error kind is a type, never a string.

**E2** Diagnostic context is attached to the original error, never by re-wrapping, so the original
stack and cause survive.

**E3** A layer that only re-raises does not re-type, re-wrap, or log.

**E4** Security, authentication and authorization failures always propagate: never
degraded to a default, never retried into silence, never returned as success.

**E5** Degradation happens only where the caller's contract states it, and is caught by type.

**E6** A handler in concurrent code unwraps aggregated errors, because a single logical failure under
a task group may arrive wrapped in a group of errors.

**E7** Cancellation is never swallowed: cleanup runs, then the cancellation propagates.

**E8** A required input is validated at function entry, in exactly one place, raising an error that
names what was required.

**E9** Exceptions are the error channel; a uniform response envelope does not replace them.


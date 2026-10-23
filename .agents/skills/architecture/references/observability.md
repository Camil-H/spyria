# Observability

Rule group `O`. Controls are in [`../standard.md`](../standard.md).

**O1** Telemetry field names, severity, and resource attributes come from the OpenTelemetry
semantic conventions, never from a local schema.

**O2a** Every log record is structured and machine-parseable, carrying severity, service name, and
deployment environment.

**O2b** Every log record carries the active trace and span ids, and `error.type` on failure.

**O3** An event identifier is a stable machine-readable name, with variable data in attributes
rather than interpolated into the identifier.

**O4** Trace context propagates as W3C `traceparent`/`tracestate` across every process hop,
including message headers.

**O5** A scheduled or batch run starts its own trace and links to what triggered it.

**O6** An outcome is logged once, by the layer that decides it.

**O7** Every dependency call, retry, breaker state change, and deadline expiry is a span.


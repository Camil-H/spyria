# 0015. OpenTelemetry traces and JSON logs

## Context

An agent turn crosses the browser, the server, the job worker, a runtime host, `spyria-agent`, the gateway and the model provider. Without a shared trace, a slow or failed turn is guesswork. Self-hosters also run very different monitoring stacks.

## Decision

- The server, `spyria-host` and `spyria-agent` write logs as one JSON line per event on stdout: timestamp, severity, a one-sentence message, an `event.name`, the trace and span ids, and domain ids as attributes. Daemon code never uses `console.*` directly.
- Traces follow a turn end to end with the official OpenTelemetry JavaScript SDK: HTTP requests, mutators, jobs (the trace context travels in the job's payload), the agent turn, host commands and model calls, with `traceparent` forwarded to the gateway.
- Export over OTLP is opt-in: it starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The production Compose file samples 10% of new traces; logs are not sampled.
- No secrets, bodies, prompts, model output or query strings in logs, and the exporter drops attributes with secret-like names as a backstop.

## Consequences

- Works with any OpenTelemetry backend, or with plain `docker compose logs`.
- A log line can be joined to its trace by id.
- Contributors log through the kernel's `log` and the app's telemetry module only.

See [operations](../guides/operations.md).

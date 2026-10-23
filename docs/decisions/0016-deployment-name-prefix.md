# 0016. A deployment name prefixes every Docker object

## Context

Spyria creates Docker objects on several machines: its own containers and volumes, and on runtime hosts the host container, runtimes, networks, credential volumes and harness volumes. Two deployments on the same Docker daemon (a development stack next to a production one, or two instances) must never see or remove each other's objects.

## Decision

- `SPYRIA_DEPLOYMENT` (default `spyria`; lowercase letters, digits and dashes) names everything: in production it is the Compose project and prefixes its containers, volumes and network; on hosts it prefixes the host container and state volume (`<name>-host`), runtimes (`<name>-rt-*`), sign-in volumes (`<name>-cred-*`) and the harness volume (`<name>-harnesses`).
- The commands Spyria generates to add a host or sign in on a machine carry the name.
- Runtime containers also carry labels, and a host acts only on containers with its labels.

## Consequences

- Development and production can share one machine safely, as long as production gets its own name (for example `spyria-prod`).
- Changing the name of a running deployment means recreating its objects.

See [self-hosting](../guides/self-hosting.md#deployment-name).

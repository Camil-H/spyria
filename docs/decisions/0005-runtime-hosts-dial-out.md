# 0005. Runtime hosts dial out

## Context

Agents need a sandbox with a shell, files and command-line tools, one per chat. Spyria should run them on any machine an organization already has, at no extra cost, including machines behind NAT, without handing anyone broad access to those machines.

## Decision

- A runtime host is any machine with Docker running `spyria-host`. An admin pairs it from the browser with one copied command.
- The host dials out to the server over a WebSocket. It never opens an inbound port.
- The server can ask for a fixed set of commands only (create, prepare, start, stop, remove, status, check and install a harness), each validated field by field. It never gets the Docker API.
- Each runtime is a hardened container from Spyria's runtime image, identified by its local content ID (hosts never pull), with its own Docker network.
- The host also relays the runtimes' model and tool calls to the server, so runtimes need no route to the gateway.

## Consequences

- Hosts work behind NAT and firewalls, and a compromised server cannot run arbitrary containers on them.
- The runtime image must be built (or loaded) on each host.
- Outbound traffic from runtimes is not filtered by Spyria; cloud operators block metadata endpoints and private ranges themselves.

## Alternatives considered

- SSH from the server to each host: an inbound door on every host, the server's key as a skeleton key, the full Docker API given away, and an `authorized_keys` back door.
- A hosted sandbox provider first: kept as a later option behind the same `SandboxProvider` interface.

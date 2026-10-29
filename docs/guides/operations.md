# Operations

What an operator watches and maintains once a deployment runs: logs, traces, health, shutdown, upgrades, failed jobs, database connections, disk and backups. Installing a deployment is in [self-hosting](./self-hosting.md). The commands below use the production Compose file; to shorten them, define an alias:

```sh
alias spyria='docker compose --env-file .env.prod -f deploy/compose.prod.yml'
```

## Logs

The server, `spyria-host` and `spyria-agent` write one JSON line per event on stdout, following OpenTelemetry's log model. Read them with `spyria logs -f server` (or `host`). Filter on `event.name`, a stable name per event (for example `http.request`, `job.run` or `gen_ai.call`), and follow a request across services with `trace_id`. Recurring background jobs (the sweeps and the usage sync) log only their retries and failures; their successful runs show only as trace spans. Errors carry `ERROR` severity with the error type and stack trace.

### What is never logged

Tokens, keys, cookies, request bodies, prompts and model output stay out of logs, errors and URLs. As a second line of defence, every app drops attributes whose names suggest a secret and strips query strings from logged paths. Logs are not sampled.

## Traces

Tracing is opt-in. Set `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_HEADERS` if your collector needs a token) in `.env.prod` to export traces and logs over OTLP/HTTP; without it, nothing leaves the machine and logs still go to stdout. The host passes the endpoint on to its runtimes, so a turn shows as one trace from the HTTP request through the job, the host and the agent to each model call.

The Compose file samples 10% of new traces (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`); child spans follow their parent's decision. Set both in `.env.prod` to change it.

## Health

```sh
curl 127.0.0.1:3300/health
spyria ps
```

`GET /health` answers `200 {"status":"ok"}`, or `503 {"status":"degraded","failing":[…]}` naming `database` and/or `gateway`, each check given 2 seconds. Every long-running service has a Compose healthcheck: Postgres (`pg_isready`), the server (`/health`), zero-cache (`/keepalive`), the gateway (`/health`), the host (`spyria-host health`, which checks its model relay answers) and the optional tunnel. Services restart `unless-stopped`.

## Shutdown

On `SIGTERM` or `SIGINT` the server stops accepting requests, lets the job worker finish its current jobs, closes the runtime hosts' connections and the database, and exits within 25 seconds. Compose gives the server and the host 30 seconds before killing them. Agent turns resume when the server starts again.

## Upgrades and migrations

```sh
git pull
bun run agent:build
spyria up -d --build
```

The `migrate` service runs Drizzle's migrations against the database and exits; the server starts only after it succeeded, and zero-cache waits for it too (it needs the publication the migrations create). A failed migration leaves the old server down and the reason in `spyria logs migrate`. Migrations are never edited once shipped, so applying them in order is always safe.

When a pull changes the gateway image, the gateway migrates its `bifrost` database on start, and some of its migrations cannot be reverted. Take a [backup](#backups) before `up`; going back to the previous gateway image means restoring that backup with it.

A new runtime image (`agent:build`) applies to runtimes started after the server restarts; running ones keep theirs. If you run hosts on other machines, rebuild their host image and load the new runtime image there too (see [self-hosting](./self-hosting.md#other-machines)).

## Jobs

Background work (starting and stopping runtimes, agent turns, sweeps, usage sync) runs from a job queue in Postgres. A job is retried up to 5 attempts in all, with a growing delay, then marked failed with its last error. Every workspace has its sweeps and usage sync scheduled within a minute of being created or restored; a dead one is scheduled again an hour after it failed. The operator CLI is in the server image:

```sh
spyria exec server bun apps/server/src/operator-cli.ts failed-jobs
spyria exec server bun apps/server/src/operator-cli.ts retry-jobs <job id>
spyria exec server bun apps/server/src/operator-cli.ts retry-jobs --all
spyria exec server bun apps/server/src/operator-cli.ts rebuild-messages [--chat <chat id>]
```

`failed-jobs` lists failed jobs with their workspace, type, attempts, last error and when they failed; `retry-jobs` requeues them with their attempts reset (a dead sweep whose next run is already queued is dropped instead); `rebuild-messages` rebuilds the messages projection from the append-only event store, for one chat or all. `workspace:restore` and `workspace:purge` restore a deleted workspace or erase it before its seven days are over ([Self-hosting](./self-hosting.md#deleting-a-workspace)). In development the same commands are `bun run jobs:failed`, `bun run jobs:retry` and `bun run db:rebuild-messages` (they read `.env.dev`).

## Database connections

Postgres allows 200 connections (`max_connections`). The stack uses at most about 100:

| Client | Connections | Setting |
|---|---|---|
| Server | 20 | `DATABASE_POOL_MAX` |
| zero-cache | 56 | upstream 20 plus its replication stream, CVR 30, change 5 (`ZERO_*_MAX_CONNS`) |
| Gateway | 20 | two stores of 10 in `infra/bifrost.json` |
| Migrations | a few, one-off | |

zero-cache needs at least one connection per sync worker in each pool. On a machine with more than 20 cores, raise its pools and `max_connections` together.

## Write-ahead log

zero-cache follows Postgres through a logical replication slot. If zero-cache stays down, Postgres keeps the WAL it has not read. The production Compose file caps that at 10 GB (`max_slot_wal_keep_size`): past it, Postgres drops the slot instead of filling its disk, and zero-cache resyncs its replica from scratch when it starts again (clients reload).

## Disk usage and cleanup

| What | Cleaned by | Yours to prune |
|---|---|---|
| Runtimes | Stopped after 60 minutes idle, removed 30 days after they stopped. A runtime's Docker network is released as soon as it stops. | Runtimes of removed hosts, with their volumes: see [Removing a host](../features/machines.md#removing-a-host). |
| Runtime image | About 300 MB of it is Chromium's headless shell for `take_screenshot`, shared by every runtime of a host. `bun run agent:build` removes the image it replaces, unless a container still uses it (old runtimes keep theirs until removed). | Old runtime images once their runtimes are gone. |
| Docker build cache | `agent:build` and `smoke:prod` prune it down to 10 GB (`docker builder prune --max-used-space 10GB`). The cache belongs to the whole Docker daemon, so this also trims other projects' cache beyond that limit, oldest first. | Below 10 GB: `docker builder prune`. |
| Base images | | Images replaced by `--pull`: `docker image ls --filter dangling=true`. |
| Test harness volume | `agent:build` fills `spyria-test-harnesses` for the Docker tests. | Remove it on a production-only machine if you do not run the tests. |
| Postgres | The event store is append-only, except the workspace purge and the redaction of a deleted message's text and attachment names, both enforced by the event trigger; the audit log, the last text of deleted messages included, is kept forever unless an Admin sets a retention in the workspace settings. | |

## Backups

Backups are the operator's responsibility; Spyria does not take any. What holds state:

| Volume | Holds | Back up |
|---|---|---|
| `<deployment>-postgres-data` | Spyria's database (data model, event store, job queue) and the gateway's `bifrost` database, in one Postgres cluster. | Yes. |
| `<deployment>-gateway-data` | The gateway's local data. | Yes. |
| `<deployment>-host` | The workspace host's pairing token. | Optional: a lost token means adding the host again. |
| `<deployment>-zero-data` | zero-cache's replica, rebuilt from Postgres. | No. |
| `.env.prod` | Every secret, including `SPYRIA_SECRETS_KEY` and `SPYRIA_GATEWAY_ENCRYPTION_KEY`. | Yes, separately and securely: without these keys the stored SSO secrets, GitHub App keys and members' API keys cannot be decrypted. |

For a consistent dump of both databases, for example:

```sh
spyria exec -T postgres pg_dumpall -U spyria > spyria-backup.sql
```

# Operations

Day-2 tasks once a deployment runs. Commands use `spyria compose <arguments>`, which runs Docker Compose on the install folder (`~/spyria` by default, or `--folder`); on a [manual install](./self-hosting.md#install), read it as its `spyria-compose` alias.

## Health

```sh
curl 127.0.0.1:3300/health
spyria compose ps
```

- `GET /health/live` checks only the process and the database. Point restarts and load balancers at it (the cloud modules do): zero-cache rebuilding or the gateway restarting is no reason to restart the server.
- Every long-running service has a Compose healthcheck and restarts `unless-stopped`. Postgres uses `pg_isready`, zero-cache `/keepalive`, the server and gateway `/health`, the host `spyria-host health` (its model relay answers), plus the optional tunnel.

## Logs

```sh
spyria compose logs -f server    # or host
```

- The server, `spyria-host` and `spyria-agent` write one JSON line per event on stdout (OpenTelemetry's log model).
- Filter on `event.name`, for example `http.request`, `job.run` or `gen_ai.call`.
- Follow a request across services with `trace_id`.
- Errors have `ERROR` severity, with the error type and stack trace.
- Recurring jobs (sweeps, usage sync) log only retries and failures; successful runs show only as trace spans.
- Logs are not sampled.

## Traces

Tracing is opt-in.

- To export traces and logs over OTLP/HTTP, set `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env.prod`, plus `OTEL_EXPORTER_OTLP_HEADERS` if your collector needs a token.
- Without it, nothing leaves the machine; logs still go to stdout.
- The host passes the endpoint to its runtimes, so a turn is one trace: HTTP request, job, host, agent, each model call.
- 10% of new traces are sampled (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`); child spans follow their parent. Set both in `.env.prod` to change it.

Good to know:
- The gateway exports no spans (Bifrost's tracing plugin writes full prompts and answers into them). A trace ends at the server's model call span: model, token counts, gateway request id.

## Shutdown

- On `SIGTERM` or `SIGINT` the server stops accepting requests, lets running jobs finish, closes host connections and the database, and exits within 25 seconds.
- Compose gives the server and the host 30 seconds before killing them.
- Agent turns resume when the server starts again.

## First workspace

Until the first workspace exists, only the setup link creates one. To print it again:

```sh
spyria setup-link
```

On a [manual install](./self-hosting.md), run it in the server container instead:

```sh
spyria-compose exec server bun apps/server/src/operator-cli.ts setup-link
```

Both are refused once a workspace exists.

## Account providers

The Google, Microsoft and OIDC apps people sign in with are deployment settings ([who can join and sign-in](./who-can-join.md)). To add one or replace a client id or secret (for example when a secret expires):

- **`spyria setup` install:** run `spyria setup` again. An empty answer keeps a saved app; `-` removes it.
- **Install made by hand:** set them in `.env.prod` ([manual install](./self-hosting.md#account-providers)), or in the secret files when [read from files](./security.md#secrets-in-files).
- **Cloud with `spyria setup --cloud`:** set the OIDC app in `terraform.tfvars` and run setup again. The `main.tf` it writes, and rewrites on every run, does not pass Google or Microsoft apps: those need a configuration you apply without the spyria tool ([AWS](./cloud-aws.md#without-the-spyria-tool), [Azure](./cloud-azure.md#without-the-spyria-tool), [Google Cloud](./cloud-gcp.md#without-the-spyria-tool)).
- **Cloud without the tool:** set them in your configuration and run `tofu apply`.

The server reads them when it restarts.

Good to know:
- While a workspace enforces SSO through the deployment's Google or Microsoft app, the server refuses to start without that app's settings, and names the provider. Set them again rather than removing them.

## Jobs

Background work (starting and stopping runtimes, agent turns, sweeps, usage sync) runs from a job queue in Postgres. The operator CLI is in the server image:

```sh
spyria compose exec server bun apps/server/src/operator-cli.ts failed-jobs
spyria compose exec server bun apps/server/src/operator-cli.ts retry-jobs <job id>
spyria compose exec server bun apps/server/src/operator-cli.ts retry-jobs --all
spyria compose exec server bun apps/server/src/operator-cli.ts rebuild-messages [--chat <chat id>]
```

- `failed-jobs` lists failed jobs: workspace, type, attempts, last error, when it failed.
- `retry-jobs` requeues them with attempts reset. A dead sweep whose next run is already queued, or superseded by a later failure of the same sweep, is dropped instead.
- `rebuild-messages` rebuilds the messages projection from the append-only event store, for one chat or all.
- `workspace:restore` and `workspace:purge` restore a deleted workspace or erase it before its seven days are over ([deleting a workspace](#deleting-a-workspace)).
- `workspace:stop-sso <workspace id>` stops a workspace enforcing its own SSO when that provider no longer signs anyone in, and releases its claimed domains, so its members sign in with their own accounts.
- In development: `bun run jobs:failed`, `bun run jobs:retry`, `bun run db:rebuild-messages` (read `.env.dev`).

Retries:
- A job gets up to 5 attempts in all, then is marked failed with its last error.
- Most jobs wait 1, 2, 3, then 4 seconds between attempts.
- Cleanup jobs wait 5 seconds, 25 seconds, 2 minutes, then 5 minutes, so a host offline for a few minutes does not fail them for good. These are, in every workspace: halting and erasing a workspace; stopping, removing and discarding runtimes; syncing keys to the gateway; removing tool servers from it.

Good to know:
- Every workspace has its sweeps and usage sync scheduled within a minute of being created or restored. A dead one is rescheduled an hour after it failed.
- Some jobs run one at a time per subject, such as the check of a member's tool sign-ins: at most one waits behind the running one. A failed one ends, keeping its error, when a newer one already waits.
- A tool sign-in check whose last attempt cannot reach a tool server keeps the stored statuses and logs a `tool_connections.not_checked` warning instead of failing.

## Deleting a workspace

An Admin deletes a workspace from **Workspace settings** ([Administration](../features/admin.md#deleting-the-workspace)). Members lose access at once; seven days later a job erases it: it removes its runtimes through the hosts, its keys and tool servers from the gateway, then its rows.

To restore it, or erase it now, during those seven days:

```sh
spyria compose exec server bun apps/server/src/operator-cli.ts workspace:restore <workspace id>
spyria compose exec server bun apps/server/src/operator-cli.ts workspace:purge <workspace id> [--abandon-failed-cleanup]
```

Good to know:
- After deletion, nothing new starts for the workspace; runtimes still starting are removed a few minutes later. Hosts stay connected until the erase is done.
- If a cleanup job keeps failing (for example a host stays offline), the erase waits so no keys stay in the gateway. It logs `workspace.purge_blocked` and retries hourly; bring the host back and it goes through.
- `--abandon-failed-cleanup` erases anyway: it drops cleanup jobs that failed or await a retry after failing (not running ones, nor ones that never failed) and prints what is left behind.
- A restore is refused once the erase has started.
- Once the last workspace is erased, the setup link creates the next one.

## Database connections

Postgres allows 200 connections (`max_connections`). The stack uses at most about 100:

| Client | Connections | Setting |
|---|---|---|
| Server | 20 | `DATABASE_POOL_MAX` |
| zero-cache | 56 | upstream 20 plus its replication stream, CVR 30, change 5 (`ZERO_*_MAX_CONNS`) |
| Gateway | 20 | two stores of 10 in `deploy/bifrost.json` |
| Migrations | a few, one-off | |

zero-cache needs at least one connection per sync worker in each pool. On a machine with more than 20 cores, raise its pools and `max_connections` together.

## Write-ahead log

- zero-cache follows Postgres through a logical replication slot. While zero-cache is down, Postgres keeps the WAL it has not read.
- The production Compose file caps that at 10 GB (`max_slot_wal_keep_size`). Past it, Postgres drops the slot instead of filling its disk.
- zero-cache then resyncs its replica from scratch when it starts again (clients reload).

## Runtime hosts

### Removing a runtime host

Removing a host in **Workspace settings › Runtimes** (or a member's machine in their profile) disconnects it and deletes nothing: the stopped host container, runtime containers and volumes stay. To clean up, for the default deployment `spyria`:

```sh
docker rm -f spyria-host
docker rm -f $(docker ps -aq --filter label=spyria.managed=1 --filter name=^spyria-rt-)
docker volume rm $(docker volume ls -q --filter name=^spyria-rt-)
docker volume rm $(docker volume ls -q --filter name=^spyria-cache-)
docker volume rm $(docker volume ls -q --filter name=^spyria-snapshot-)
docker network rm $(docker network ls -q --filter label=spyria.managed=1 --filter name=^spyria-rt-)
docker volume rm spyria-host
```

- Runtime volumes hold the agents' files: remove them only when nothing in them is needed. Caches hold only downloads; snapshots, a repository after its setup.
- For another deployment, replace `spyria-` with `<deployment>-`; the name filter spares other deployments on the same daemon.
- On a member's machine, also `docker volume rm` the sign-ins (`spyria-cred-claude-code`, `spyria-cred-codex`) and harnesses (`spyria-harnesses`) if the machine is not added again.
- Added to another workspace instead, the new host removes these runtimes and volumes on connect, as unknown to that workspace.

### Outbound traffic

- Each runtime has its own Docker network; runtimes on a host cannot reach each other where Docker isolates networks (Docker Engine on Linux; some desktop Docker products do not).
- Outbound traffic from runtimes is not filtered. On a cloud VM you set up yourself, block the metadata endpoint (`169.254.169.254`) and private ranges in the provider's firewall; the cloud modules' runtime hosts already do.

### Several deployments on one machine

Every Docker object carries the deployment name `SPYRIA_DEPLOYMENT`: host container and state volume `<deployment>-host`, runtimes `<deployment>-rt-*`, sign-ins `<deployment>-cred-*`, harnesses `<deployment>-harnesses`. Two deployments on one daemon, such as development and production, never see each other's runtimes.

## Disk usage and cleanup

**Runtimes**
- Cleaned automatically: stopped after 60 minutes idle, removed 7 days after they stopped. A runtime's Docker network is released as soon as it stops.
- On each connection, a host removes the runtimes Spyria no longer knows, and a package cache with the last runtime that uses it.
- Runtimes kept ready are replaced after a day. A host keeps the newest snapshot of each repository that keeps runtimes ready and removes the others once unused.
- Yours to prune: runtimes of removed hosts, with their volumes ([removing a runtime host](#removing-a-runtime-host)).

**Runtime image**
- About 350 MB of it is Chromium, for `take_screenshot` and members' browsers, shared by every runtime of a host.
- Each member's browser is its own container next to a runtime, with up to 1 GB of memory. It stops after 10 minutes unused, is removed with its sign-ins when its runtime stops, and is refused when the host has less than 768 MB free.
- Downloads wait in the browser's volume on the host's disk until the member saves them: at most 30 minutes while the browser runs, never past the runtime, at most 4 GB per browser.
- `bun run agent:build` removes the image it replaces unless a container still uses it (old runtimes keep theirs until removed).
- Yours to prune: old runtime images once their runtimes are gone.

**Docker build cache**
- `agent:build` and `smoke:prod` prune it to 10 GB (`docker builder prune --max-used-space 10GB`). This also trims other projects' cache past that limit, oldest first, since the cache is the Docker daemon's.
- Yours to prune below 10 GB: `docker builder prune`.

**Base images**
- Yours to prune: images replaced by `--pull`, listed by `docker image ls --filter dangling=true`.

**Test harness volume**
- `agent:build` fills `spyria-test-harnesses` for the Docker tests. Remove it on a production-only machine if you do not run the tests.

**Postgres**
- The event store is append-only, except the workspace purge and the redaction of a deleted message's text and attachment names, both enforced by the event trigger.
- The audit log, including the last text of deleted messages, is kept forever unless an Admin sets a retention in the workspace settings.

## Backups

```sh
spyria backup
spyria restore backups/spyria-<time>.dump
```

Backing up:
- `spyria backup` dumps both databases (Spyria's and the gateway's) into `backups/` of the install folder, keeping the newest 7 of each (`--keep <n>`).
- `spyria upgrade`, and `spyria setup --version` when it changes the version, take one first.
- Run it on a schedule, for example from cron, and copy `backups/` and `.env` off the machine.

`spyria restore`:
1. Reads the file whole first, and refuses one it cannot restore completely (a truncated file, a plain SQL dump).
2. Asks before replacing anything (`--yes` skips the question).
3. Backs up the database it replaces into `backups/`.
4. Stops the server, zero-cache, the gateway and the host.
5. Restores that database and drops zero-cache's replica so it is rebuilt.
6. Starts everything again.

What holds state:

| Volume | Holds | Back up |
|---|---|---|
| `<deployment>-postgres-data` | Spyria's database (data model, event store, job queue) and the gateway's `bifrost` database, in one Postgres cluster. | Yes. |
| `<deployment>-gateway-data` | The gateway's local data. | Yes. |
| `<deployment>-host` | The workspace host's pairing token. | Optional: a lost token means adding the host again. |
| `<deployment>-zero-data` | zero-cache's replica, rebuilt from Postgres. | No. |
| `.env` (`.env.prod` on an install made by hand), and the files of any [secret read from a file](./security.md#secrets-in-files) | Every secret, including `SPYRIA_SECRETS_KEY` (and `SPYRIA_PREVIOUS_SECRETS_KEYS` during a [rotation](./security.md#rotating-the-secrets-key)) and `SPYRIA_GATEWAY_ENCRYPTION_KEY`. | Yes, separately and securely: without these keys the stored SSO secrets, GitHub App keys and members' API keys cannot be decrypted. |

Good to know:
- For a consistent dump of both databases by hand (restore it with `psql` into an empty Postgres; `spyria restore` does not take it):

  ```sh
  spyria compose exec -T postgres pg_dumpall -U spyria > all-databases.sql
  ```

# Operations

Day-2 tasks once a deployment runs. Installing is in [manual install](./self-hosting.md).

Commands use the `spyria` tool from `spyria setup`: `spyria compose <arguments>` runs Docker Compose on its install folder (`~/spyria` by default, or `--folder`). On an install made by hand, define this alias and read `spyria compose` as `spyria-compose` below:

```sh
alias spyria-compose='docker compose --env-file .env.prod -f compose.prod.yml'
```

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

### What is never logged

Tokens, keys, cookies, request bodies, prompts and model output stay out of logs, errors and URLs. Every app also drops attributes whose names suggest a secret and strips query strings from logged paths.

## Traces

Tracing is opt-in.

- To export traces and logs over OTLP/HTTP, set `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env.prod`, plus `OTEL_EXPORTER_OTLP_HEADERS` if your collector needs a token.
- Without it, nothing leaves the machine; logs still go to stdout.
- The host passes the endpoint to its runtimes, so a turn is one trace: HTTP request, job, host, agent, each model call.
- 10% of new traces are sampled (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`); child spans follow their parent. Set both in `.env.prod` to change it.

Good to know:
- The gateway exports no spans (Bifrost's tracing plugin writes full prompts and answers into them). A trace ends at the server's model call span: model, token counts, gateway request id.

## Health

```sh
curl 127.0.0.1:3300/health
spyria compose ps
```

- `GET /health` answers `200 {"status":"ok"}`, or `503 {"status":"degraded","failing":[…]}` naming `database`, `gateway` and/or `zero`. Each check has 2 seconds.
- `GET /health/live` checks only the process and the database. Point restarts and load balancers at it (the cloud modules do): zero-cache rebuilding or the gateway restarting is no reason to restart the server.
- Every long-running service has a Compose healthcheck and restarts `unless-stopped`. Postgres uses `pg_isready`, zero-cache `/keepalive`, the server and gateway `/health`, the host `spyria-host health` (its model relay answers), plus the optional tunnel.

## Shutdown

- On `SIGTERM` or `SIGINT` the server stops accepting requests, lets running jobs finish, closes host connections and the database, and exits within 25 seconds.
- Compose gives the server and the host 30 seconds before killing them.
- Agent turns resume when the server starts again.

## Upgrades and migrations

```sh
spyria upgrade            # the latest release, or: spyria upgrade 1.3.0
```

It backs up both databases into `backups/`, fetches the release's Compose file and gateway configuration, sets `SPYRIA_VERSION`, pulls and starts the images, waits for `/health`, and prints the link to what changed.

By hand:
1. Take a [backup](#backups).
2. Set `SPYRIA_VERSION` in `.env.prod` to the new release.
3. Replace `compose.prod.yml` and `bifrost.json` with the release's.
4. Run `spyria-compose pull`, then `spyria-compose up -d`.

From a clone ([manual install](./self-hosting.md#from-a-clone)): `git pull`, `bun run agent:build`, then:

```sh
docker compose --env-file .env.prod -f deploy/compose.prod.yml -f deploy/compose.build.yml up -d --build
```

Migrations:
- The `migrate` service runs Drizzle's migrations and exits. The server and zero-cache start only after it succeeded.
- A failed migration leaves the old server down; the reason is in `spyria compose logs migrate`.
- Shipped migrations are never edited, so applying them in order is always safe.
- A new gateway image migrates its `bifrost` database on start, and some of those migrations cannot be reverted. Going back to the previous gateway image means restoring the backup taken before `up`.

Runtimes and hosts:
- Each server version names its runtime image by digest. A host pulls it when its first runtime starts after the upgrade.
- A stopped runtime is recreated on the new image when it starts again (its volumes are kept); running runtimes keep their image until they stop.
- Hosts on other machines keep their host image and show **Update available** in Workspace settings (or on the member's profile).
- **Update needed** means the release raised the minimum protocol: the host is refused until updated.
- Either badge opens the command that replaces the host container in place ([machines](../features/machines.md#versions-and-updates)).
- From a clone, also rebuild those hosts' image and load the new runtime image there.

## First workspace

Until the first workspace exists, only the setup link creates one. To print it again:

```sh
spyria setup-link
```

It is refused once a workspace exists.

## Account providers

The Google, Microsoft and OIDC apps people sign in with are deployment settings ([who can join and sign-in](./who-can-join.md)). To add one or replace a client id or secret (for example when a secret expires):

- **`spyria setup` install:** run `spyria setup` again. An empty answer keeps a saved app; `-` removes it.
- **Install made by hand:** set them in `.env.prod` ([manual install](./self-hosting.md#account-providers)), or in the secret files when [read from files](#secrets-in-files).
- **Cloud:** set them in `terraform.tfvars` ([clouds](./cloud.md)).

The server reads them when it restarts.

Good to know:
- While a workspace enforces SSO through the deployment's Google or Microsoft app, the server refuses to start without that app's settings, and names the provider. Set them again rather than removing them.

## Secrets in files

The server, its operator CLI, the Compose migrations and `spyria-host` read each secret from the environment, or from a file when `<NAME>_FILE` holds its path. Example: `SPYRIA_SECRETS_KEY_FILE=/run/secrets/spyria_secrets_key` instead of `SPYRIA_SECRETS_KEY=…`. This works with Docker secrets, Kubernetes secret volumes and vault agents.

- A trailing newline in the file is dropped.
- A secret given both ways (non-empty value and `_FILE` path) stops the process at start, naming the setting.
- So does a file that cannot be read.

| Process | Secrets it reads from a file |
|---|---|
| Server, operator CLI, migrations (Compose) | `DATABASE_URL`, `SPYRIA_TOKEN_SECRET`, `SPYRIA_SECRETS_KEY`, `SPYRIA_PREVIOUS_SECRETS_KEYS`, `SPYRIA_SETUP_TOKEN`, `SPYRIA_INSTALL_HOST_TOKEN`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `SPYRIA_OIDC_CLIENT_SECRET`, `SPYRIA_GATEWAY_ADMIN_PASSWORD`, `OTEL_EXPORTER_OTLP_HEADERS` |
| `spyria-host` | `SPYRIA_HOST_CLAIM_URL`, `OTEL_EXPORTER_OTLP_HEADERS`, `HTTPS_PROXY`, `HTTP_PROXY` |

The other Compose services are not Spyria's:
- Postgres reads `POSTGRES_PASSWORD_FILE` itself.
- zero-cache and the gateway read their secrets from the environment only. So `SPYRIA_POSTGRES_PASSWORD` and `SPYRIA_GATEWAY_ADMIN_PASSWORD` always stay in `.env`, and must match the values in the files.

An install made by `spyria setup` keeps its secrets in `.env`: `spyria compose` runs only the Compose file it installed. On an install made by hand, put the files in an override file and add it to the alias (`-f compose.prod.yml -f compose.secrets.yml`):

```yaml
services:
  server:
    environment:
      SPYRIA_SECRETS_KEY: ''
      SPYRIA_SECRETS_KEY_FILE: /run/secrets/spyria_secrets_key
    secrets: [spyria_secrets_key]
secrets:
  spyria_secrets_key:
    file: ./secrets/spyria_secrets_key
```

The empty `SPYRIA_SECRETS_KEY` counts as unset, so the value from `.env` does not conflict with the file.

## Rotation intervals

Rotate a secret at once when it may have leaked or someone who held it leaves. Write each new value in `.env` (`.env.prod` on an install made by hand), and also in its file when a service [reads it from a file](#secrets-in-files).

| Secret | Rotate | How |
|---|---|---|
| `SPYRIA_SECRETS_KEY` | Every 12 months | [Rotating the secrets key](#rotating-the-secrets-key). No downtime; runtimes move to the new key as they restart. |
| `SPYRIA_TOKEN_SECRET` | Every 12 months | Set a new value, restart the server. Members stay signed in (sessions are not signed with it; 15-minute session tokens are renewed from them). A sign-in, GitHub connection or GitHub App creation in progress starts over. |
| `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `SPYRIA_OIDC_CLIENT_SECRET` | Every 12 months, and before the provider expires it (Microsoft Entra allows at most 24 months) | Add a second secret at the provider, set it ([account providers](#account-providers)), restart the server, then delete the old one at the provider. |
| `SPYRIA_POSTGRES_PASSWORD`, `SPYRIA_GATEWAY_DB_PASSWORD` | Every 12 months | Steps below the table. |
| `SPYRIA_ZERO_ADMIN_PASSWORD` | Every 12 months | Set a new value, run `spyria compose up -d zero-cache`. |
| `SPYRIA_GATEWAY_ADMIN_PASSWORD` | Every 12 months | Write it in `.env` (and the file of `SPYRIA_GATEWAY_ADMIN_PASSWORD_FILE` if used), run `spyria compose up -d gateway server`, check `/health` does not list `gateway` as failing. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `CLOUDFLARE_TUNNEL_TOKEN` | Per the collector's or Cloudflare's policy | Issue a new token there, set it, restart the services that use it. |
| `SPYRIA_GATEWAY_ENCRYPTION_KEY` | Only after a leak | Changing it makes members' API keys in the gateway unreadable: wipe the gateway's database and have members enter their keys again. |
| `SPYRIA_GATEWAY_SETUP_TOKEN` | Only after a leak | Set a new value, run `spyria compose up -d gateway`, check `/health` does not list `gateway` as failing. |
| `SPYRIA_SETUP_TOKEN`, `SPYRIA_INSTALL_HOST_TOKEN`, `SPYRIA_HOST_CLAIM_URL` | Not needed | One-time: spent once the first workspace exists or the host is paired. |

To rotate `SPYRIA_POSTGRES_PASSWORD` or `SPYRIA_GATEWAY_DB_PASSWORD` (the Postgres role keeps the password it was created with):
1. Run `spyria compose exec postgres psql -U spyria`, then `\password spyria` (or `\password bifrost` for the gateway's). This keeps the new value out of shell history.
2. Write it in `.env`, and in the files of `DATABASE_URL_FILE` and `POSTGRES_PASSWORD_FILE` if used.
3. Run `spyria compose up -d`. It restarts the services that use it, Postgres included, for a few seconds.

Good to know:
- `spyria setup` generates long-lived secrets from 32 random bytes each; the intervals limit how long a copied value stays useful.
- The cloud modules generate secrets in the cloud's secret manager. They cannot rotate `SPYRIA_SECRETS_KEY` yet.

## Rotating the secrets key

`SPYRIA_SECRETS_KEY` seals stored secrets (SSO client secrets, GitHub App credentials, members' GitHub tokens) and derives the key the server uses to reach each runtime. To replace it:

1. In `.env` (`.env.prod` on an install made by hand):
   - Move the current `SPYRIA_SECRETS_KEY` into `SPYRIA_PREVIOUS_SECRETS_KEYS` (comma-separated after any key already there).
   - Set `SPYRIA_SECRETS_KEY` to a new value of at least 32 characters, for example from `openssl rand -hex 32`.

   When they are [read from files](#secrets-in-files), edit the files instead (the override blanks the `.env` values): append the current key to the file of `SPYRIA_PREVIOUS_SECRETS_KEYS_FILE` (create that file and setting if needed), and write the new key into the file of `SPYRIA_SECRETS_KEY_FILE`.
2. Run `spyria compose up -d server`. The server now seals with the new key and still opens what previous keys sealed; running runtimes keep answering.
3. Seal every stored secret again:

   ```sh
   spyria compose exec server bun apps/server/src/operator-cli.ts secrets:reseal
   ```

   It reports how many secrets it resealed and how many running runtimes still use a previous key. Run it again later until it reports none:
   - A runtime moves to the new key the next time it starts.
   - An idle runtime stops after an hour.
   - A runtime in constant use never goes idle: **Stop runtime** in its chat's runtime menu stops it, and the next prompt starts it on the new key.
4. Remove `SPYRIA_PREVIOUS_SECRETS_KEYS` (or `SPYRIA_PREVIOUS_SECRETS_KEYS_FILE` and its file) and run `spyria compose up -d server` again.

Good to know:
- Keep the previous key with the backups taken before step 3: their secrets are sealed with it.
- The cloud modules do not take a previous key yet, so a cloud deployment cannot rotate the key this way.

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
- `workspace:restore` and `workspace:purge` restore a deleted workspace or erase it before its seven days are over.
- `workspace:stop-sso <workspace id>` stops a workspace enforcing its own SSO when that provider no longer signs anyone in, and releases its claimed domains, so its members sign in with their own accounts ([manual install](./self-hosting.md#deleting-a-workspace)).
- In development: `bun run jobs:failed`, `bun run jobs:retry`, `bun run db:rebuild-messages` (read `.env.dev`).

Retries:
- A job gets up to 5 attempts in all, then is marked failed with its last error.
- Most jobs wait 1, 2, 3, then 4 seconds between attempts.
- Cleanup jobs wait 5 seconds, 25 seconds, 2 minutes, then 5 minutes, so a host offline for a few minutes does not fail them for good. These are, in every workspace: halting and erasing a workspace; stopping, removing and discarding runtimes; syncing keys to the gateway; removing tool servers from it.

Good to know:
- Every workspace has its sweeps and usage sync scheduled within a minute of being created or restored. A dead one is rescheduled an hour after it failed.
- Some jobs run one at a time per subject, such as the check of a member's tool sign-ins: at most one waits behind the running one. A failed one ends, keeping its error, when a newer one already waits.
- A tool sign-in check whose last attempt cannot reach a tool server keeps the stored statuses and logs a `tool_connections.not_checked` warning instead of failing.

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

## Disk usage and cleanup

**Runtimes**
- Cleaned automatically: stopped after 60 minutes idle, removed 7 days after they stopped. A runtime's Docker network is released as soon as it stops.
- On each connection, a host removes the runtimes Spyria no longer knows, and a package cache with the last runtime that uses it.
- Runtimes kept ready are replaced after a day. A host keeps the newest snapshot of each repository that keeps runtimes ready and removes the others once unused.
- Yours to prune: runtimes of removed hosts, with their volumes ([Removing a host](../features/machines.md#removing-a-host)).

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
| `.env` (`.env.prod` on an install made by hand), and the files of any [secret read from a file](#secrets-in-files) | Every secret, including `SPYRIA_SECRETS_KEY` (and `SPYRIA_PREVIOUS_SECRETS_KEYS` during a [rotation](#rotating-the-secrets-key)) and `SPYRIA_GATEWAY_ENCRYPTION_KEY`. | Yes, separately and securely: without these keys the stored SSO secrets, GitHub App keys and members' API keys cannot be decrypted. |

Good to know:
- For a consistent dump of both databases by hand (restore it with `psql` into an empty Postgres; `spyria restore` does not take it):

  ```sh
  spyria compose exec -T postgres pg_dumpall -U spyria > all-databases.sql
  ```

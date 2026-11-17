# Operations

What an operator watches and maintains once a deployment runs: logs, traces, health, shutdown, upgrades, failed jobs, database connections, disk and backups. Installing a deployment is in [manual install](./self-hosting.md). The commands below use the `spyria` tool that `spyria setup` installed: `spyria compose <arguments>` runs Docker Compose on its install folder (`~/spyria` by default, or `--folder`). On an install made by hand, define an alias that does the same:

```sh
alias spyria-compose='docker compose --env-file .env.prod -f compose.prod.yml'
```

and read `spyria compose` as `spyria-compose` below.

## Logs

The server, `spyria-host` and `spyria-agent` write one JSON line per event on stdout, following OpenTelemetry's log model. Read them with `spyria compose logs -f server` (or `host`). Filter on `event.name`, a stable name per event (for example `http.request`, `job.run` or `gen_ai.call`), and follow a request across services with `trace_id`. Recurring background jobs (the sweeps and the usage sync) log only their retries and failures; their successful runs show only as trace spans. Errors carry `ERROR` severity with the error type and stack trace.

### What is never logged

Tokens, keys, cookies, request bodies, prompts and model output stay out of logs, errors and URLs. As a second line of defence, every app drops attributes whose names suggest a secret and strips query strings from logged paths. Logs are not sampled.

## Traces

Tracing is opt-in. Set `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_HEADERS` if your collector needs a token) in `.env.prod` to export traces and logs over OTLP/HTTP; without it, nothing leaves the machine and logs still go to stdout. The host passes the endpoint on to its runtimes, so a turn shows as one trace from the HTTP request through the job, the host and the agent to each model call.

The model gateway exports no spans of its own: Bifrost's tracing plugin writes the full prompt and answer into every span, which Spyria keeps out of telemetry, so a trace ends at the server's model call span, which carries the model, the token counts and the gateway's request id.

The Compose file samples 10% of new traces (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`); child spans follow their parent's decision. Set both in `.env.prod` to change it.

## Health

```sh
curl 127.0.0.1:3300/health
spyria compose ps
```

`GET /health` answers `200 {"status":"ok"}`, or `503 {"status":"degraded","failing":[…]}` naming `database`, `gateway` and/or `zero`, each check given 2 seconds. `GET /health/live` checks the process and the database alone: it is what a platform restarting or routing to the server should watch (the cloud modules do), since zero-cache rebuilding its replica or the gateway restarting is no reason to restart the server or take it out of service. Every long-running service has a Compose healthcheck: Postgres (`pg_isready`), the server (`/health`), zero-cache (`/keepalive`), the gateway (`/health`), the host (`spyria-host health`, which checks its model relay answers) and the optional tunnel. Services restart `unless-stopped`.

## Shutdown

On `SIGTERM` or `SIGINT` the server stops accepting requests, lets the job worker finish its current jobs, closes the runtime hosts' connections and the database, and exits within 25 seconds. Compose gives the server and the host 30 seconds before killing them. Agent turns resume when the server starts again.

## Upgrades and migrations

```sh
spyria upgrade            # the latest release, or: spyria upgrade 1.3.0
```

It backs up both databases into `backups/`, fetches the release's Compose file and gateway configuration, sets `SPYRIA_VERSION`, pulls the images, starts them and waits for `/health`, then prints the link to what changed. By hand: set `SPYRIA_VERSION` in `.env.prod` to the new release, replace `compose.prod.yml` and `bifrost.json` with the release's, then `spyria-compose pull` and `spyria-compose up -d`.

(From a clone, as in [Manual install](./self-hosting.md#from-a-clone): `git pull`, `bun run agent:build`, then `docker compose --env-file .env.prod -f deploy/compose.prod.yml -f deploy/compose.build.yml up -d --build`.) The `migrate` service runs Drizzle's migrations against the database and exits; the server starts only after it succeeded, and zero-cache waits for it too (it needs the publication the migrations create). A failed migration leaves the old server down and the reason in `spyria compose logs migrate`. Migrations are never edited once shipped, so applying them in order is always safe.

When a pull changes the gateway image, the gateway migrates its `bifrost` database on start, and some of its migrations cannot be reverted. Take a [backup](#backups) before `up`; going back to the previous gateway image means restoring that backup with it.

Each version's server names its runtime image by digest; a host pulls it when the first runtime starts on it after the upgrade, a stopped runtime is recreated on it when it starts again (its volumes are kept), and running runtimes keep theirs until they stop. Hosts on other machines keep their host image and show **Update available** in Workspace settings (or on the member's profile), or **Update needed** when the release raised the minimum protocol, in which case they are refused until updated; either badge opens the command that replaces the host container in place (see [machines](../features/machines.md#versions-and-updates)). From a clone, rebuild their host image and load the new runtime image there as well.

## First workspace

Until the first workspace exists, only the setup link creates one. To print it again:

```sh
spyria setup-link
```

It is refused once a workspace exists.

## Account providers

The Google, Microsoft and OIDC apps that people sign in to their account with are settings of the deployment ([who can join and sign-in](./who-can-join.md)). To add one, or replace a client id or secret, for example when a secret expires, run `spyria setup` again: an empty answer keeps a saved app and `-` removes it. An install made by hand sets them in `.env.prod` ([manual install](./self-hosting.md#account-providers)), or the client secrets in their files when they are [read from files](#secrets-in-files), a cloud deployment in `terraform.tfvars` ([clouds](./cloud.md)); the server reads them when it restarts.

A workspace that enforces SSO with the deployment's Google or Microsoft app signs in through it too, so the server refuses to start while such a workspace exists without that app's settings, naming the provider: set them again rather than removing them.

## Secrets in files

The server, its operator CLI, the migrations of the Compose file and `spyria-host` read each of their secrets from the environment, or from a file when `<NAME>_FILE` holds its path: `SPYRIA_SECRETS_KEY_FILE=/run/secrets/spyria_secrets_key` instead of `SPYRIA_SECRETS_KEY=…`. That is how Docker secrets, Kubernetes secret volumes and vault agents hand them over, so nothing else needs to be set up for them. A trailing newline in the file is dropped. A secret given both ways (a non-empty value and a `_FILE` path) stops the process at start rather than letting one silently win, and so does a file that cannot be read; both errors name the setting.

| Process | Secrets it reads from a file |
|---|---|
| Server, operator CLI, migrations (Compose) | `DATABASE_URL`, `SPYRIA_TOKEN_SECRET`, `SPYRIA_SECRETS_KEY`, `SPYRIA_PREVIOUS_SECRETS_KEYS`, `SPYRIA_SETUP_TOKEN`, `SPYRIA_INSTALL_HOST_TOKEN`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `SPYRIA_OIDC_CLIENT_SECRET`, `SPYRIA_GATEWAY_ADMIN_PASSWORD`, `OTEL_EXPORTER_OTLP_HEADERS` |
| `spyria-host` | `SPYRIA_HOST_CLAIM_URL`, `OTEL_EXPORTER_OTLP_HEADERS`, `HTTPS_PROXY`, `HTTP_PROXY` |

The other services of the Compose file are not Spyria's: Postgres reads `POSTGRES_PASSWORD_FILE` itself, while zero-cache and the gateway take their secrets from the environment only. `spyria compose` runs the Compose file it installed and nothing else, so an install made by `spyria setup` keeps its secrets in `.env`. On an install made by hand, put the files in an override file and add it to the alias (`-f compose.prod.yml -f compose.secrets.yml`), for example:

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

The empty `SPYRIA_SECRETS_KEY` counts as unset, so the value Compose would otherwise take from `.env` does not conflict with the file.

## Rotation intervals

Recommended intervals for each secret of a deployment. Rotate any of them at once when it may have leaked, and when someone who held it leaves. Setting a new value means writing it where the service reads the secret: in `.env` (`.env.prod` on an install made by hand), or in its file when it is [read from a file](#secrets-in-files).

| Secret | Rotate | How, and what it costs |
|---|---|---|
| `SPYRIA_SECRETS_KEY` | Every 12 months | [Rotating the secrets key](#rotating-the-secrets-key): no downtime, runtimes move to the new key as they restart. |
| `SPYRIA_TOKEN_SECRET` | Every 12 months | Set a new value and restart the server. Members stay signed in: their sessions are not signed with it, and their 15-minute session tokens are renewed from them. A sign-in, GitHub connection or GitHub App creation in progress during the restart starts over. |
| `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `SPYRIA_OIDC_CLIENT_SECRET` | Every 12 months, and before the provider expires it (the Microsoft Entra admin center offers at most 24 months) | Add a second secret at the provider, set it ([account providers](#account-providers)) and restart the server, then delete the old one at the provider. |
| `SPYRIA_POSTGRES_PASSWORD`, `SPYRIA_GATEWAY_DB_PASSWORD` | Every 12 months | The role keeps the password it was created with: change it in Postgres first (`\password spyria` in `spyria compose exec postgres psql -U spyria`, `\password bifrost` for the gateway's, so the new value stays out of the shell history), then where the services read it (`.env`, or the file of `DATABASE_URL_FILE` and `POSTGRES_PASSWORD_FILE` when they are read from files), then run `spyria compose up -d`, which restarts the services that use it, Postgres included, for a few seconds. |
| `SPYRIA_ZERO_ADMIN_PASSWORD` | Every 12 months | Set a new value and run `spyria compose up -d zero-cache`. |
| `SPYRIA_GATEWAY_ADMIN_PASSWORD` | Every 12 months | The server and the gateway share it: set a new value, run `spyria compose up -d gateway server`, then check that `/health` does not list `gateway` as failing. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `CLOUDFLARE_TUNNEL_TOKEN` | As the collector's or Cloudflare's policy says | Issue a new token there, set it, restart the services that use it. |
| `SPYRIA_GATEWAY_ENCRYPTION_KEY` | Never, only after a leak | Changing it makes the members' API keys in the gateway unreadable: wipe the gateway's database and have members enter their keys again. |
| `SPYRIA_GATEWAY_SETUP_TOKEN` | Never, only after a leak | Set a new value, run `spyria compose up -d gateway`, then check that `/health` does not list `gateway` as failing. |
| `SPYRIA_SETUP_TOKEN`, `SPYRIA_INSTALL_HOST_TOKEN`, `SPYRIA_HOST_CLAIM_URL` | Not needed | One-time: spent once the first workspace exists, or once the host is paired. |

`spyria setup` generates the long-lived secrets from 32 random bytes each, so these intervals limit how long a copied value stays useful rather than how long it resists guessing. The cloud modules generate the secrets in the cloud's secret manager; they cannot rotate `SPYRIA_SECRETS_KEY` yet (see below).

## Rotating the secrets key

`SPYRIA_SECRETS_KEY` seals the stored secrets (SSO client secrets, GitHub App credentials, members' GitHub tokens) and derives the key the server uses to reach each runtime. To replace it, for example when it may have leaked:

1. In `.env` (`.env.prod` on an install made by hand), move the current value of `SPYRIA_SECRETS_KEY` into `SPYRIA_PREVIOUS_SECRETS_KEYS` (comma-separated after any key already there), and set `SPYRIA_SECRETS_KEY` to a new value of at least 32 characters, for example from `openssl rand -hex 32`. When they are [read from files](#secrets-in-files), do the same in the files: write the current key into the file of `SPYRIA_PREVIOUS_SECRETS_KEYS_FILE` and the new one into the file of `SPYRIA_SECRETS_KEY_FILE`: the override blanks their values from `.env`, so editing `.env` would change nothing.
2. Restart the server with `spyria compose up -d server`. It now seals with the new key and still opens what the previous keys sealed; running runtimes keep answering.
3. Seal every stored secret again with the new key:

   ```sh
   spyria compose exec server bun apps/server/src/operator-cli.ts secrets:reseal
   ```

   It says how many secrets it sealed again, and how many running runtimes still use a previous key. A runtime moves to the new key the next time it starts, and an idle runtime stops after an hour; run the command again later until it reports none. A runtime in use all along never goes idle: **Stop runtime** in its chat's runtime menu stops it, and the next prompt starts it on the new key.
4. Remove `SPYRIA_PREVIOUS_SECRETS_KEYS` (or `SPYRIA_PREVIOUS_SECRETS_KEYS_FILE` and its file) and run `spyria compose up -d server` again.

Keep the previous key with the backups taken before step 3: the secrets in them are sealed with it. The cloud modules generate `SPYRIA_SECRETS_KEY` and do not take a previous key yet, so a cloud deployment cannot rotate it this way.

## Jobs

Background work (starting and stopping runtimes, agent turns, sweeps, usage sync) runs from a job queue in Postgres. A job is retried up to 5 attempts in all, then marked failed with its last error. Most jobs wait 1, 2, 3 then 4 seconds between attempts, so a member soon hears that something could not start; the jobs that clean up after a deleted workspace (halting and erasing it, stopping, removing and discarding runtimes, syncing keys to the gateway and removing tool servers from it) wait 5 seconds, 25 seconds, 2 minutes then 5 minutes, in every workspace and not only a deleted one, so a host that is offline for a few minutes does not fail them for good. Every workspace has its sweeps and usage sync scheduled within a minute of being created or restored; a dead one is scheduled again an hour after it failed. Some jobs run one at a time per subject, such as the check of a member's tool sign-ins: at most one waits behind the running one, and a failed one ends, keeping its error, when a newer one already waits, since that one redoes the work. A check of tool sign-ins whose last attempt still cannot reach a tool server keeps the stored statuses and logs a `tool_connections.not_checked` warning instead of failing. The operator CLI is in the server image:

```sh
spyria compose exec server bun apps/server/src/operator-cli.ts failed-jobs
spyria compose exec server bun apps/server/src/operator-cli.ts retry-jobs <job id>
spyria compose exec server bun apps/server/src/operator-cli.ts retry-jobs --all
spyria compose exec server bun apps/server/src/operator-cli.ts rebuild-messages [--chat <chat id>]
```

`failed-jobs` lists failed jobs with their workspace, type, attempts, last error and when they failed; `retry-jobs` requeues them with their attempts reset (a dead sweep whose next run is already queued, or that a later failure of the same sweep supersedes, is dropped instead); `rebuild-messages` rebuilds the messages projection from the append-only event store, for one chat or all. `workspace:restore` and `workspace:purge` restore a deleted workspace or erase it before its seven days are over; `workspace:stop-sso <workspace id>` stops a workspace enforcing its own SSO when that provider no longer signs anyone in, and releases its claimed domains, so its members sign in with their own accounts ([Manual install](./self-hosting.md#deleting-a-workspace)). In development the same commands are `bun run jobs:failed`, `bun run jobs:retry` and `bun run db:rebuild-messages` (they read `.env.dev`).

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

zero-cache follows Postgres through a logical replication slot. If zero-cache stays down, Postgres keeps the WAL it has not read. The production Compose file caps that at 10 GB (`max_slot_wal_keep_size`): past it, Postgres drops the slot instead of filling its disk, and zero-cache resyncs its replica from scratch when it starts again (clients reload).

## Disk usage and cleanup

| What | Cleaned by | Yours to prune |
|---|---|---|
| Runtimes | Stopped after 60 minutes idle, removed 7 days after they stopped. A runtime's Docker network is released as soon as it stops. A host removes the runtimes Spyria no longer knows each time it connects, and a package cache with the last runtime that uses it. Runtimes kept ready are replaced after a day; a host keeps the newest snapshot of each repository that keeps runtimes ready, and removes the others once no runtime uses them. | Runtimes of removed hosts, with their volumes: see [Removing a host](../features/machines.md#removing-a-host). |
| Runtime image | About 350 MB of it is Chromium, for `take_screenshot` and members' browsers, shared by every runtime of a host. Each member's browser is a container of its own next to a runtime, with up to 1 GB of memory: stopped after 10 minutes without use, removed with its sign-ins when its runtime stops, and refused when the host has less than 768 MB free. A download waits in the browser's volume, on the host's disk, until its member saves it, for at most 30 minutes while the browser runs, and never past the runtime; at most 4 GB waits in one browser. `bun run agent:build` removes the image it replaces, unless a container still uses it (old runtimes keep theirs until removed). | Old runtime images once their runtimes are gone. |
| Docker build cache | `agent:build` and `smoke:prod` prune it down to 10 GB (`docker builder prune --max-used-space 10GB`). The cache belongs to the whole Docker daemon, so this also trims other projects' cache beyond that limit, oldest first. | Below 10 GB: `docker builder prune`. |
| Base images | | Images replaced by `--pull`: `docker image ls --filter dangling=true`. |
| Test harness volume | `agent:build` fills `spyria-test-harnesses` for the Docker tests. | Remove it on a production-only machine if you do not run the tests. |
| Postgres | The event store is append-only, except the workspace purge and the redaction of a deleted message's text and attachment names, both enforced by the event trigger; the audit log, the last text of deleted messages included, is kept forever unless an Admin sets a retention in the workspace settings. | |

## Backups

`spyria backup` dumps both databases (Spyria's and the gateway's) into `backups/` of the install folder, keeping the newest 7 of each (`--keep <n>`); `spyria upgrade`, and `spyria setup --version` when it changes the version, take one first. Run it on a schedule, for example from cron, and copy `backups/` and `.env` off the machine. `spyria restore backups/spyria-<time>.dump` asks before it replaces anything (`--yes` skips the question), backs up the database it replaces into `backups/`, stops the server, zero-cache, the gateway and the host, restores that database, drops zero-cache's replica so it is rebuilt, and starts everything again. What holds state:

| Volume | Holds | Back up |
|---|---|---|
| `<deployment>-postgres-data` | Spyria's database (data model, event store, job queue) and the gateway's `bifrost` database, in one Postgres cluster. | Yes. |
| `<deployment>-gateway-data` | The gateway's local data. | Yes. |
| `<deployment>-host` | The workspace host's pairing token. | Optional: a lost token means adding the host again. |
| `<deployment>-zero-data` | zero-cache's replica, rebuilt from Postgres. | No. |
| `.env` (`.env.prod` on an install made by hand), and the files of any [secret read from a file](#secrets-in-files) | Every secret, including `SPYRIA_SECRETS_KEY` (and `SPYRIA_PREVIOUS_SECRETS_KEYS` during a [rotation](#rotating-the-secrets-key)) and `SPYRIA_GATEWAY_ENCRYPTION_KEY`. | Yes, separately and securely: without these keys the stored SSO secrets, GitHub App keys and members' API keys cannot be decrypted. |

`spyria restore` reads each file whole before it changes anything, and refuses one it cannot restore completely, such as a truncated file or a plain SQL dump. By hand, a consistent dump of both databases, which `spyria restore` does not take (restore it with `psql` into an empty Postgres):

```sh
spyria compose exec -T postgres pg_dumpall -U spyria > all-databases.sql
```

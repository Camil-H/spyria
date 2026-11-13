# Manual install

Spyria runs as one Docker Compose file on one machine: Postgres, the migrations, the server with the built web app, zero-cache, the model gateway and its database, and optionally a runtime host on the same machine. Any server works, at home or at any provider, as long as it runs Docker and can be reached over HTTPS. This guide is the install by hand, and what [`spyria setup`](./install.md) does underneath: what you need, the settings, the steps from an empty machine to a first workspace. When something goes wrong, see [troubleshooting](./troubleshooting.md). Day-to-day running (logs, traces, health, backups, disk) is in [operations](./operations.md); how the parts fit together is in the [architecture overview](../architecture/overview.md).

## What you need

| Requirement | Why |
|---|---|
| Docker with Compose | Every service runs in a container, from images published on GHCR for `amd64` and `arm64` and signed with cosign (`spyria-server`, `spyria-host`, `spyria-agent`). |
| An HTTPS origin, for example `https://spyria.example.com` | The server refuses to start in production without `https://` (secure cookies, OIDC redirects, GitHub callbacks). |
| A reverse proxy or tunnel that terminates TLS | For example Caddy, nginx, Traefik or a tunnel service, routing the hostname to the server (see below). |
| At least one sign-in provider | Google, Microsoft or any OIDC provider that people sign in to their account with, or the own provider of the first workspace. Production sign-in is single sign-on only. |
| A GitHub App (later, from the app) | Only for dev chats on repositories. |

### Path routing

Everything is served from one origin by one target, `server:3000`: the web app, `/api`, `/auth`, `/h/<code>` (host claim links), the `/host` WebSocket, `/gateway-oauth`, `/api/github/webhooks`, `/health`, and `/zero/*`, which the server forwards to zero-cache (HTTP and the sync WebSocket, streamed both ways). Your proxy must:

- terminate TLS for the origin and forward plain HTTP to `server:3000`;
- pass WebSocket upgrades (`/zero/`, `/host`, `/api/stream`) and keep long-lived connections open;
- never route anything to the gateway (`gateway:8080`). Its admin API returns tool servers' header secrets in plain text, so it must stay reachable on the Compose network only. Compose publishes no gateway port, and the server forwards only the tool sign-in callback (`/gateway-oauth/api/oauth/callback`) to it.

The server is reachable only on the Compose network `<deployment>-network`, so run the proxy or tunnel connector as a container attached to that network. It also answers on `127.0.0.1:${SPYRIA_LOCAL_PORT:-3300}` on the machine itself, for health checks and a local proxy.

Run one server instance. Agent streams, runtime host connections and rate limits are held in the server process.

## Deployment name

`SPYRIA_DEPLOYMENT` names the Compose project and prefixes every container, volume, network and image of the deployment, and every Docker object the app creates on runtime hosts. With `SPYRIA_DEPLOYMENT=spyria-prod`:

| Object | Name |
|---|---|
| Compose containers | `spyria-prod-postgres`, `spyria-prod-migrate`, `spyria-prod-server`, `spyria-prod-zero-cache`, `spyria-prod-gateway-database`, `spyria-prod-gateway`, `spyria-prod-host` |
| Volumes | `spyria-prod-postgres-data`, `spyria-prod-zero-data`, `spyria-prod-gateway-data`, `spyria-prod-host` |
| Network | `spyria-prod-network` |
| Images built by Compose from a clone (`compose.build.yml`) | `spyria-prod-server` (server and migrations), `spyria-prod-host` |
| Created on runtime hosts | runtimes `spyria-prod-rt-*`, harness sign-ins `spyria-prod-cred-*`, harness installs `spyria-prod-harnesses` |

Two deployments can therefore share one Docker daemon without either host seeing the other's runtimes. Give production its own name: the default `spyria` is the development stack's.

## Configuration: `.env.prod`

Copy `.env.example` to `.env.prod` and fill every key marked `[prod]`. Compose reads only those keys; it sets the gateway URL, the redirect URI (`<origin>/auth/callback`), the auth mode (`sso`) and `SPYRIA_ENV=production` itself. Secrets are letters and digits only (the Postgres password goes into a URL), for example from `openssl rand -hex 32`.

| Key | Purpose |
|---|---|
| `SPYRIA_DEPLOYMENT` | Deployment name (lowercase letters, digits, dashes), see above. |
| `SPYRIA_VERSION` | The version to run: a release tag without its `v`, for example `1.0.0`. Compose refuses to start without it. |
| `SPYRIA_IMAGES` | Registry and namespace the images were published under, default `ghcr.io/camil-h`. Only for images published by a fork's own Publish workflow: its server and host images carry that namespace (the server names the runtime image under it, the host pulls from it alone), so a mirror of the originals cannot be used this way. |
| `SPYRIA_APP_ORIGIN` | Public origin, `https://`. |
| `SPYRIA_TOKEN_SECRET` | Signs session tokens. At least 32 characters. |
| `SPYRIA_SETUP_TOKEN` | One-time setup token, at least 32 characters: only the setup link carrying it can create the first workspace; spent once one exists. |
| `SPYRIA_SECRETS_KEY` | Encrypts stored secrets (SSO client secrets, GitHub App keys) with AES-GCM, and derives the key the server uses to reach each runtime. At least 32 characters. Never just change it: a stored secret sealed with a key the server no longer has must be entered again. To replace it, [rotate it](./operations.md#rotating-the-secrets-key). |
| `SPYRIA_PREVIOUS_SECRETS_KEYS` | Only while [rotating the secrets key](./operations.md#rotating-the-secrets-key): the previous values of `SPYRIA_SECRETS_KEY`, comma-separated. The server still opens what they sealed and still reaches the runtimes started with them, but seals nothing new with them. |
| `SPYRIA_TRUSTED_PROXY` | Leave unset, except in the [Cloudflare example](#example-cloudflare) (`cloudflare`), or behind a load balancer that appends the client to `X-Forwarded-For` and is the only way in (`x-forwarded-for:<hops from the end>`; the cloud modules set it). Behind a proxy, rate limits on unauthenticated routes see every client as the proxy's address. |
| `SPYRIA_GOOGLE_CLIENT_ID`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_ID`, `SPYRIA_MICROSOFT_CLIENT_SECRET` | Optional account providers: apps of the deployment that people sign in to their account with, see [account providers](#account-providers). |
| `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID`, `SPYRIA_OIDC_CLIENT_SECRET` | Optional account provider of any other OIDC provider, set together or not at all. |
| `SPYRIA_GATEWAY_ADMIN_USER`, `SPYRIA_GATEWAY_ADMIN_PASSWORD` | Admin login of the gateway. |
| `SPYRIA_GATEWAY_ENCRYPTION_KEY` | Encrypts members' API keys inside the gateway. Never change it without wiping the gateway's database. |
| `SPYRIA_GATEWAY_SETUP_TOKEN` | Gateway setup token. |
| `SPYRIA_GATEWAY_DB_PASSWORD` | Password of the gateway's own database role. |
| `SPYRIA_POSTGRES_PASSWORD` | Password of the `spyria` database role, set on the first start and kept in the Postgres volume. |
| `SPYRIA_ZERO_ADMIN_PASSWORD` | Admin password of zero-cache. |
| `SPYRIA_LOCAL_PORT` | Loopback port of the server, default `3300`. |
| `COMPOSE_PROFILES` | Optional services, comma-separated: `host` (see below). |
| `SPYRIA_HOST_CLAIM_URL` | Profile `host`: the claim URL (see [Runtime host on this machine](#runtime-host-on-this-machine)), handed to the host in its environment rather than its command, so other users of the machine cannot read the pairing code in `ps`. |
| `SPYRIA_DOCKER_GROUP` | Profile `host`: group owning the Docker socket, `0` on macOS, `stat -c %g /var/run/docker.sock` on Linux. Default `0`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Optional OTLP export of traces and logs, see [operations](./operations.md#traces). |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Trace sampling, default 10% of new traces. |

### Compose profiles

| Profile | Adds | Needs |
|---|---|---|
| `host` | `<deployment>-host`: a workspace runtime host on this machine's Docker, read-only, all capabilities dropped, `no-new-privileges` | `SPYRIA_HOST_CLAIM_URL`, `SPYRIA_DOCKER_GROUP` on Linux |

### What the server checks at start

The server image sets `SPYRIA_ENV=production`. The server then checks its settings before anything else and refuses to start, printing `Spyria cannot start in production:` and one line per problem:

- `SPYRIA_AUTH_MODE` is `sso`.
- `SPYRIA_TOKEN_SECRET`, `SPYRIA_SECRETS_KEY` and `SPYRIA_SETUP_TOKEN` are set, at least 32 characters, and not a development default (`spyria` or `spyria-dev-…`).
- `SPYRIA_APP_ORIGIN` starts with `https://`, and `SPYRIA_OIDC_REDIRECT_URI` is on that origin.
- `SPYRIA_GATEWAY_URL`, `SPYRIA_GATEWAY_ADMIN_USER` and `SPYRIA_GATEWAY_ADMIN_PASSWORD` are set, and the gateway login is not a development default.
- `SPYRIA_INSTALL_HOST_TOKEN`, when set, is 16 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.
- `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID` and `SPYRIA_OIDC_CLIENT_SECRET` are set together or not at all.
- `SPYRIA_TRUSTED_PROXY` is unset, `cloudflare`, or `x-forwarded-for:1` to `3`.

Read the list with `docker compose --env-file .env.prod -f compose.prod.yml logs server`.

## Install

Three files from the release you run, in a folder of their own (`v1.0.0` below):

```sh
mkdir spyria && cd spyria
curl -fsSLO https://raw.githubusercontent.com/Camil-H/spyria/v1.0.0/deploy/compose.prod.yml
curl -fsSLO https://raw.githubusercontent.com/Camil-H/spyria/v1.0.0/deploy/bifrost.json
curl -fsSL https://raw.githubusercontent.com/Camil-H/spyria/v1.0.0/.env.example -o .env.prod
# fill .env.prod, with SPYRIA_VERSION=1.0.0
docker compose --env-file .env.prod -f compose.prod.yml pull
docker compose --env-file .env.prod -f compose.prod.yml up -d
```

The images are signed with cosign (keyless, by the Publish workflow of the repository); to check one before running it:

```sh
cosign verify ghcr.io/camil-h/spyria-server:1.0.0 \
  --certificate-identity-regexp '^https://github.com/Camil-H/spyria/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The server image names the runtime image of its version by digest (`ghcr.io/camil-h/spyria-agent@sha256:…`, spyria-agent with Pi, node, git, ripgrep and poppler-utils); each runtime host pulls it from that registry the first time it needs it, so the first runtime on a host waits for the pull. A host accepts no other image from the server than that one, or a local content ID.

Compose starts Postgres, applies the migrations (`migrate`, one-shot), creates the gateway's role and database (`gateway-database`, one-shot), then the gateway, the server (after the migrations succeeded and the gateway is healthy) and zero-cache. `docker compose --env-file .env.prod -f compose.prod.yml ps` shows each service's healthcheck; the server's `/health` reports `zero` and `gateway` among what it checks.

### From a clone

To run images built on the machine instead (a build of your own, or `bun run smoke:prod`), add `deploy/compose.build.yml` after the production file: it builds the server and host images and mounts the runtime image's content ID, which `bun run agent:build` writes to `apps/agent/image-id` (Bun and a clone needed). Hosts then accept only that content ID, so every host must hold the same local build. `SPYRIA_VERSION` is still required; any value does.

```sh
bun install && bun run agent:build
docker compose --env-file .env.prod -f deploy/compose.prod.yml -f deploy/compose.build.yml up -d --build
```

## First workspace and sign-in

Production signs in through single sign-on only: with an account at a provider of the deployment, or through a workspace's own provider when it enforces SSO. Who joins what is in [who can join and sign-in](./who-can-join.md), the model in [security](../architecture/security.md) and the settings in [admin](../features/admin.md#sign-in-and-sso).

1. Set at least one [account provider](#account-providers), or register a client at your organization's provider with the redirect URI `<origin>/auth/callback`.
2. Open the setup link: the origin with the setup token, `<origin>/?setup=<SPYRIA_SETUP_TOKEN>`, which `spyria setup` prints, or `operator-cli.ts setup-link` from the server container (see [operations](./operations.md#first-workspace)). Without it, a fresh deployment only says that it is being set up, so nobody else can claim it between the start and your first sign-in. With it, the sign-in screen offers **Create a workspace**: its name, then an account provider, or your organization's provider (Google Workspace, Microsoft Entra with its tenant id, or **Other OIDC** with an issuer), which the workspace then enforces. Spyria checks the provider's discovery document, encrypts the client secret and never shows it again.
3. Submitting opens the provider's sign-in, and the person who completes it becomes the Admin of the new workspace. From then on, anyone signed in with an account can create a workspace of their own; without account providers, nobody can.

### Account providers

People sign in to their account through apps of the deployment, set in `.env.prod`, each with the redirect URI `<origin>/auth/callback`:

- **Google**: in Google Cloud, create an OAuth client of type *Web application*, and an *External* consent screen asking for `openid`, `email` and `profile`. Set `SPYRIA_GOOGLE_CLIENT_ID` and `SPYRIA_GOOGLE_CLIENT_SECRET`. Any Google account signs in, Gmail included.
- **Microsoft**: in Microsoft Entra, register an app for *Accounts in any organizational directory and personal Microsoft accounts* with a web redirect URI, and create a client secret. Set `SPYRIA_MICROSOFT_CLIENT_ID` and `SPYRIA_MICROSOFT_CLIENT_SECRET`. A tenant that does not let users consent to apps needs its Entra admin to consent on the first sign-in.
- **Another OIDC provider**: register a client with the scopes `openid`, `email` and `profile`, and set `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID` and `SPYRIA_OIDC_CLIENT_SECRET`. It must confirm addresses with `email_verified: true` ([decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)).

A workspace enforcing Google Workspace or Microsoft Entra can also sign in through the deployment's Google or Microsoft app, without a client id or secret of its own. Through Google it then admits only accounts managed by the Google Workspace of their address's domain, and Gmail addresses; through Microsoft, only its own tenant. The server refuses to start while a workspace uses an app whose variables are missing, naming the provider: set them again rather than removing them.

## Deleting a workspace

An Admin deletes a workspace from **Workspace settings** ([Administration](../features/admin.md#deleting-the-workspace)). Its members lose access at once, and seven days later a background job erases it: it asks the hosts to remove its runtimes, removes its keys and tool servers from the gateway, then deletes its rows in chunks. From the deletion on, the job worker runs only those cleanup jobs for the workspace, and a few minutes later it removes any runtime that was still starting. Hosts stay connected until the erasing is done, since the removals go through them, but nothing new starts on them for that workspace. If a cleanup job fails for good, for example removing runtimes from a host that stays offline, the erasing waits and logs `workspace.purge_blocked` every hour: bring the host back and retry the job (`bun run jobs:retry`), or erase anyway with `--abandon-failed-cleanup`, which prints what is left behind.

During those seven days the operator can restore the workspace, or erase it now:

```sh
docker compose --env-file .env.prod -f compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts workspace:restore <workspace id>
docker compose --env-file .env.prod -f compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts workspace:purge <workspace id> [--abandon-failed-cleanup]
```

A restore is refused once the erasing has started. When the last workspace of the deployment is erased, the setup link creates the next one.

## Runtime host on this machine

Runtime chats run on runtime hosts: machines with Docker running the `spyria-host` program, which dials out to Spyria. See [machines](../features/machines.md) for what a host does and how members add their own machine.

`spyria setup` pairs it by itself: it generates a one-time install code (`SPYRIA_INSTALL_HOST_TOKEN`), points the host at `http://server:3000/h/<code>` and adds the `host` profile; the host waits until the first workspace exists, then appears in **Workspace settings** as **This machine**, removable like any host. The code works once, and only for the first workspace: to turn the host on once a workspace exists, `spyria setup --host` asks for the command of **Add runtime host** and points the host at its code instead.

By hand, before the first workspace exists, set those two settings yourself: `SPYRIA_INSTALL_HOST_TOKEN` to 16 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, and `SPYRIA_HOST_CLAIM_URL` to `http://server:3000/h/<that code>`. Once a workspace exists, take the command of **Add runtime host** instead.

To run the workspace host on the Compose machine:

1. Signed in as an Admin, open **Workspace settings > Runtimes > Add runtime host**, give it a name and copy the command.
2. Take the claim URL at its end (`https://spyria.example.com/h/<code>`), replace its origin with `http://server:3000`, and put it in `SPYRIA_HOST_CLAIM_URL`: `http://server:3000/h/<code>`.
3. Add `host` to `COMPOSE_PROFILES` (and set `SPYRIA_DOCKER_GROUP` on Linux), then run the same `pull` and `up -d`.

The host pairs once and keeps its token in the `<deployment>-host` volume; the claim URL is not used again. Do not also run the copied command on this machine: it would replace the Compose container, which has the same name.

### Other machines

A host on another machine (a second workspace host, or a member's own machine) runs the command the app shows: it names the published host image of the deployment's version (`ghcr.io/camil-h/spyria-host:1.0.0`), which Docker pulls, adapts to rootless or rooted Docker by itself, and the host pulls the runtime image by digest when the first runtime starts. A deployment built from a clone instead needs its own two images on every host: `docker build -t spyria-prod-host apps/host` from the same version, and the runtime image with the exact content ID in the server's `apps/agent/image-id` (building it again elsewhere may give another ID; `docker save <image id> | ssh <machine> docker load` keeps it, same CPU architecture only).

### Many runtimes on one host

Each running runtime gets its own Docker bridge network, released when the runtime stops, so runtimes on one host cannot reach each other where Docker's isolation rules apply (Docker Engine on Linux). Docker's default address pools hold about 30 such networks per daemon. A host meant to run more than about 25 runtimes at once needs smaller pools in `/etc/docker/daemon.json`, then a Docker restart:

```json
{ "default-address-pools": [{ "base": "10.200.0.0/16", "size": 28 }] }
```

That gives 4,096 networks.

### Behind an outbound proxy

A host that reaches Spyria only through an HTTP proxy takes it from `HTTPS_PROXY` (`HTTP_PROXY` for an `http://` origin), skipping the names in `NO_PROXY`. The host command passes these three variables on from the shell it runs in, so set them there before running it. The host uses the proxy for its connection to Spyria alone: the calls it relays to its runtimes, and its own health check, never go through it. Runtimes get no proxy settings.

### Relay limits

A host relays each HTTP call between the server and a runtime in base64 chunks of 256 KiB, so a body travels unchanged whatever its bytes, up to 256 MiB instead of the 64 MiB of one frame. A runtime's event stream gets 1 MiB of credit: the host sends that much ahead of the server's acknowledgements, holds the rest, and closes only that stream once it holds more than 8 MiB. A host too old for this relay is below the minimum protocol: the server refuses it with the command that updates it, rather than speaking its older relay.

### Egress

Spyria does not filter runtimes' outbound traffic. On a cloud machine, block the metadata endpoint (`169.254.169.254`) and private address ranges in the provider's firewall, so an agent cannot read the machine's cloud credentials or reach internal services.

## GitHub App (dev chats)

Each deployment registers its own GitHub App. An Admin opens **Workspace settings > GitHub**:

- **Create the GitHub App on GitHub** (on a private account or an organization) sends GitHub a manifest with Spyria's permissions (contents, pull requests and workflows write, issues, checks, actions and metadata read), its events (pull requests, reviews, review comments and threads, check suites and runs) and its URLs, all computed from the origin. GitHub creates the App, Spyria stores its credentials sealed with `SPYRIA_SECRETS_KEY`, and GitHub asks which repositories to install it on.
- **Create it manually** opens the steps and a form as a fallback, for example on a GitHub Enterprise server without manifests: the App id, the client id, the private key, the client secret and the webhook secret. Secrets are shown only as set and replaced by entering a new value, under **Change the App credentials** once the App is connected.

Webhooks arrive on `/api/github/webhooks`; Spyria checks each delivery's `X-Hub-Signature-256` with the webhook secret and ignores a delivery id it already received. The server image includes `git`: publishing runs on the server, which pushes a git bundle from the runtime with the chat owner's own token. Members link their GitHub account in their profile. See [dev mode](../features/dev-mode.md).

## Tool servers in the gateway

Admins add tool servers (MCP) to each workspace's catalogue in **Workspace settings > Tools**, and members connect those they sign in to in **Profile > Connections**; their OAuth tokens stay in the gateway (see [Admin](../features/admin.md#tools)). Nothing is set up per deployment. The OAuth redirect goes through `<origin>/gateway-oauth/api/oauth/callback`. When a member connects, Spyria first deletes the member's sign-in to that server and checks none is left, then starts a new one by calling one of the tools the member may use, a read-only one when the server marks any. With no sign-in, the gateway asks for one before the call reaches the server. A server members sign in to must let the gateway register itself (OAuth dynamic client registration), as Notion's does; one that needs a pre-registered OAuth app, such as GitHub's, cannot be added yet.

## Upgrading

Set `SPYRIA_VERSION` in `.env.prod` to the new release, then:

```sh
docker compose --env-file .env.prod -f compose.prod.yml pull
docker compose --env-file .env.prod -f compose.prod.yml up -d
```

The `migrate` service applies new migrations, and the server starts only after it succeeded. Hosts pull the new runtime image when their next runtime starts, stopped runtimes are recreated on it, and running runtimes keep theirs until they stop. Hosts on other machines keep working and show **Update available** (or **Update needed**, refused, when the release raised the minimum protocol) with the command that updates them in place. More in [operations](./operations.md#upgrades-and-migrations).

## Checking the Compose file

```sh
bun run agent:build
bun run smoke:prod
```

`smoke:prod` starts the production Compose file with the build override (`compose.build.yml`, so the images come from this clone) under a throwaway name (`spyria-smoke-<random>`) with generated secrets, waits for every healthcheck, checks `/health`, the web app's `index.html` and a hashed asset with their cache headers, that `/auth/mode` says the deployment is being set up and offers creating the first workspace only with the setup token, and that `/zero` reaches zero-cache through the server (HTTP and WebSocket). It then removes the containers, volumes, network and every image it built, even on failure. It does not start the optional profiles, and it takes a few minutes.

## Example: Cloudflare

One way to get an HTTPS origin and an organization's own provider without opening a port, using Cloudflare Tunnel, Access and Email Routing. Any equivalent works. The Compose file has an optional `cloudflare` profile that runs the tunnel connector (`<deployment>-cloudflared`) on the Compose network.

1. **Tunnel.** Cloudflare Zero Trust > Networks > Tunnels > Create a tunnel (cloudflared). Copy its token to `CLOUDFLARE_TUNNEL_TOKEN` in `.env.prod`, add `cloudflare` to `COMPOSE_PROFILES` and start the stack: Cloudflare saves routes only once a connector runs. Then add one public hostname, `spyria.example.com` without a path, to `http://server:3000`.

   Set `SPYRIA_TRUSTED_PROXY=cloudflare` so rate limits key on Cloudflare's `CF-Connecting-IP` header. Only do this when the server is reachable through Cloudflare alone, or clients could choose their own address.
2. **Mailbox.** Email > Email Routing on the domain: forward an address such as `admin@example.com` to your inbox. It receives the Access one-time PINs.
3. **OIDC through Access.** Zero Trust > Access > Applications > Add an application > SaaS, OIDC, redirect URL `https://spyria.example.com/auth/callback`, and a policy allowing emails ending in `@example.com`. Add **One-time PIN** as a login method (or your identity provider) and select it on the application. In **Create a workspace**, choose **Other OIDC** with the issuer `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`, the client id and the client secret Access shows. The workspace then enforces it.

Pitfalls specific to this setup:

- **`502` with a TLS error in cloudflared:** the tunnel route uses `https://`; use `http://server:3000`.
- **Access asks for a Cloudflare password:** One-time PIN (or your identity provider) is not selected on the Access application.
- **Access says "The account does not have access":** an existing Cloudflare session in the browser; sign in from a private window.


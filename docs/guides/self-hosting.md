# Self-hosting

Spyria runs as one Docker Compose file on one machine: Postgres, the migrations, the server with the built web app, zero-cache, the model gateway and its database, and optionally a runtime host on the same machine. Any server works, at home or at any provider, as long as it runs Docker and can be reached over HTTPS. This guide lists what you need, the steps from an empty machine to a first workspace, and the mistakes that cost the most time. Day-to-day running (logs, traces, health, backups, disk) is in [operations](./operations.md); how the parts fit together is in the [architecture overview](../architecture/overview.md).

## What you need

| Requirement | Why |
|---|---|
| Docker with Compose | Every service runs in a container. |
| Bun and a clone of the repository | `bun run agent:build` builds the runtime image on the machine; no image is published. |
| An HTTPS origin, for example `https://spyria.example.com` | The server refuses to start in production without `https://` (secure cookies, OIDC redirects, GitHub callbacks). |
| A reverse proxy or tunnel that terminates TLS and routes by path | For example Caddy, nginx, Traefik or a tunnel service. Zero's sync WebSocket and the server share the origin (see below). |
| An OIDC provider for the first workspace | Google Workspace, Microsoft Entra, or any OIDC issuer. Production sign-in is per-workspace SSO only. |
| Any SMTP service that sends from your domain | Domain verification links (invites send no email). |
| A GitHub App (later, from the app) | Only for dev chats on repositories. |

### Path routing

Everything is served from one origin:

| Path | Goes to | What it is |
|---|---|---|
| `/zero/*` | `zero-cache:4848` | Zero's sync WebSocket; the web app syncs on `<origin>/zero`. |
| everything else | `server:3000` | The web app, `/api`, `/auth`, `/h/<code>` (host claim links), the `/host` WebSocket, `/gateway-oauth`, `/api/github/webhooks`, `/health`. |

Your proxy must:

- terminate TLS for the origin and forward plain HTTP to both targets;
- match `/zero/` before the catch-all route;
- pass WebSocket upgrades (`/zero/`, `/host`, `/api/stream`) and keep long-lived connections open;
- never route anything to the gateway (`gateway:8080`). Its admin API returns tool servers' header secrets in plain text, so it must stay reachable on the Compose network only. Compose publishes no gateway port, and the server forwards only the tool sign-in callback (`/gateway-oauth/api/oauth/callback`) to it.

Both targets are reachable only on the Compose network `<deployment>-network`, so run the proxy or tunnel connector as a container attached to that network. The server also answers on `127.0.0.1:${SPYRIA_LOCAL_PORT:-3300}` on the machine itself, for health checks and a local proxy.

Run one server instance. Agent streams, runtime host connections and rate limits are held in the server process.

## Deployment name

`SPYRIA_DEPLOYMENT` names the Compose project and prefixes every container, volume, network and image of the deployment, and every Docker object the app creates on runtime hosts. With `SPYRIA_DEPLOYMENT=spyria-prod`:

| Object | Name |
|---|---|
| Compose containers | `spyria-prod-postgres`, `spyria-prod-migrate`, `spyria-prod-server`, `spyria-prod-zero-cache`, `spyria-prod-gateway-database`, `spyria-prod-gateway`, `spyria-prod-host` |
| Volumes | `spyria-prod-postgres-data`, `spyria-prod-zero-data`, `spyria-prod-gateway-data`, `spyria-prod-host` |
| Network | `spyria-prod-network` |
| Images built by Compose | `spyria-prod-server` (server and migrations), `spyria-prod-host` |
| Created on runtime hosts | runtimes `spyria-prod-rt-*`, harness sign-ins `spyria-prod-cred-*`, harness installs `spyria-prod-harnesses` |

Two deployments can therefore share one Docker daemon without either host seeing the other's runtimes. Give production its own name: the default `spyria` is the development stack's.

## Configuration: `.env.prod`

Copy `.env.example` to `.env.prod` and fill every key marked `[prod]`. Compose reads only those keys; it sets the gateway URL, the redirect URI (`<origin>/auth/callback`), the auth mode (`sso`) and `SPYRIA_ENV=production` itself. Secrets are letters and digits only (the Postgres password goes into a URL), for example from `openssl rand -hex 32`.

| Key | Purpose |
|---|---|
| `SPYRIA_DEPLOYMENT` | Deployment name (lowercase letters, digits, dashes), see above. |
| `SPYRIA_APP_ORIGIN` | Public origin, `https://`. |
| `SPYRIA_TOKEN_SECRET` | Signs session tokens. At least 32 characters. |
| `SPYRIA_SECRETS_KEY` | Encrypts stored secrets (SSO client secrets, GitHub App keys) with AES-GCM, and derives the key the server uses to reach each runtime. At least 32 characters. Never change it: every stored secret would have to be entered again, and existing runtimes would stop answering the server. |
| `SPYRIA_TRUSTED_PROXY` | Leave unset, except in the [Cloudflare example](#example-cloudflare). Behind a proxy, rate limits on unauthenticated routes see every client as the proxy's address. |
| `SPYRIA_SMTP_URL`, `SPYRIA_MAIL_FROM` | Mail, for example `smtp://user:pass@smtp.example.com:587` and `Spyria <spyria@example.com>`. |
| `SPYRIA_GOOGLE_CLIENT_ID`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_ID`, `SPYRIA_MICROSOFT_CLIENT_SECRET` | Optional apps of the deployment for one-click sign-in, see [One-click Google and Microsoft](#one-click-google-and-microsoft). |
| `SPYRIA_GATEWAY_ADMIN_USER`, `SPYRIA_GATEWAY_ADMIN_PASSWORD` | Admin login of the gateway. |
| `SPYRIA_GATEWAY_ENCRYPTION_KEY` | Encrypts members' API keys inside the gateway. Never change it without wiping the gateway's database. |
| `SPYRIA_GATEWAY_SETUP_TOKEN` | Gateway setup token. |
| `SPYRIA_GATEWAY_DB_PASSWORD` | Password of the gateway's own database role. |
| `SPYRIA_POSTGRES_PASSWORD` | Password of the `spyria` database role, set on the first start and kept in the Postgres volume. |
| `SPYRIA_ZERO_ADMIN_PASSWORD` | Admin password of zero-cache. |
| `SPYRIA_LOCAL_PORT` | Loopback port of the server, default `3300`. |
| `COMPOSE_PROFILES` | Optional services, comma-separated: `host` (see below). |
| `SPYRIA_HOST_CLAIM_URL` | Profile `host`: the claim URL (see [Runtime host on this machine](#runtime-host-on-this-machine)). |
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
- `SPYRIA_TOKEN_SECRET` and `SPYRIA_SECRETS_KEY` are set, at least 32 characters, and not a development default (`spyria` or `spyria-dev-…`).
- `SPYRIA_APP_ORIGIN` starts with `https://`, and `SPYRIA_OIDC_REDIRECT_URI` is on that origin.
- `SPYRIA_SMTP_URL`, `SPYRIA_MAIL_FROM`, `SPYRIA_GATEWAY_URL`, `SPYRIA_GATEWAY_ADMIN_USER` and `SPYRIA_GATEWAY_ADMIN_PASSWORD` are set, and the gateway login is not a development default.
- `SPYRIA_TRUSTED_PROXY` is unset or `cloudflare`.

Read the list with `docker compose --env-file .env.prod -f deploy/compose.prod.yml logs server`.

## Install

```sh
git clone <repository> spyria && cd spyria
cp .env.example .env.prod
bun install && bun run agent:build
docker compose --env-file .env.prod -f deploy/compose.prod.yml up -d --build
```

`bun run agent:build` builds the runtime image (spyria-agent with Pi, node, git and ripgrep) and writes its content ID to `apps/agent/image-id`, which Compose mounts into the server. Runtime hosts never pull an image: they accept only a local content ID. Use a clone for production only: a development `agent:build` in the same checkout would change production's runtime image at its next restart.

Compose starts Postgres, applies the migrations (`migrate`, one-shot), creates the gateway's role and database (`gateway-database`, one-shot), then the gateway, the server (after the migrations succeeded and the gateway is healthy) and zero-cache. `docker compose --env-file .env.prod -f deploy/compose.prod.yml ps` shows each service's healthcheck.

## First workspace and sign-in

Production signs in through each workspace's own OIDC provider. Identities are matched on the provider's issuer and subject; the email domain routes a person to the right provider. See [security](../architecture/security.md) for the model and [admin](../features/admin.md) for the settings.

1. Register an OIDC client at your provider with the redirect URI `<origin>/auth/callback`, or set the deployment's own Google or Microsoft app once ([below](#one-click-google-and-microsoft)).
2. Open the origin. On a fresh deployment the sign-in screen offers **Create a workspace**: the organization name, its email domain and the provider (Google Workspace, Microsoft Entra with its tenant id, or **Other OIDC** with an issuer). Spyria checks the provider's discovery document, encrypts the client secret and never shows it again.
3. Submitting opens the provider's sign-in. The first person who completes it with an address at that domain becomes the Admin of the new workspace. From then on the screen no longer offers creating a workspace and the server refuses it; **New workspace** in the app reuses the member's verified domain and provider.
4. Verify the domain right away: in **Workspace settings > Setup SSO**, send the single-use link (valid 24 hours) to any address at the domain and open it. Until the domain is verified, the workspace cannot invite, and only its existing members can sign in.

Without working SMTP, an operator can verify a domain directly from the server container:

```sh
docker compose --env-file .env.prod -f deploy/compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts sso:verify-domain --workspace <workspace id> --domain example.com
```

### One-click Google and Microsoft

To spare every workspace registering its own client, register the deployment's own apps once and set them in `.env.prod`:

- **Google**: in Google Cloud, create an OAuth client of type *Web application* with the redirect URI `<origin>/auth/callback`, and an *External* consent screen asking for `openid`, `email` and `profile`. Set `SPYRIA_GOOGLE_CLIENT_ID` and `SPYRIA_GOOGLE_CLIENT_SECRET`.
- **Microsoft**: in Microsoft Entra, register an app for *Accounts in any organizational directory* with the web redirect URI `<origin>/auth/callback`, and create a client secret. Set `SPYRIA_MICROSOFT_CLIENT_ID` and `SPYRIA_MICROSOFT_CLIENT_SECRET`. A tenant that does not let users consent to apps needs its Entra admin to consent on the first sign-in.

Creating a workspace and **Setup SSO** then offer **Continue with Google** or **Continue with Microsoft** without a client id or secret. Through Google, whichever app, only verified addresses of accounts in the domain's Google Workspace sign in; through Microsoft, a person is recognized by their Entra object id, the same in every app of their tenant. The server refuses to start while a live workspace uses an app whose variables are missing, naming the provider: set them again rather than removing them.

## Deleting a workspace

An Admin deletes a workspace from **Workspace settings** ([Administration](../features/admin.md#deleting-the-workspace)). Its members lose access at once, and seven days later a background job erases it: it asks the hosts to remove its runtimes, removes its keys and tool servers from the gateway, then deletes its rows in chunks. From the deletion on, the job worker runs only those cleanup jobs for the workspace, and a few minutes later it removes any runtime that was still starting. Hosts stay connected until the erasing is done, since the removals go through them, but nothing new starts on them for that workspace. If a cleanup job fails for good, for example removing runtimes from a host that stays offline, the erasing waits and logs `workspace.purge_blocked` every hour: bring the host back and retry the job (`bun run jobs:retry`), or erase anyway with `--abandon-failed-cleanup`, which prints what is left behind.

During those seven days the operator can restore the workspace, or erase it now:

```sh
docker compose --env-file .env.prod -f deploy/compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts workspace:restore <workspace id>
docker compose --env-file .env.prod -f deploy/compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts workspace:purge <workspace id> [--abandon-failed-cleanup]
```

A restore is refused once the erasing has started. When the last workspace of the deployment is erased, its domain is free and the sign-in page offers **Create a workspace** again.

## Runtime host on this machine

Runtime chats run on runtime hosts: machines with Docker running the `spyria-host` program, which dials out to Spyria. See [machines](../features/machines.md) for what a host does and how members add their own machine.

To run the workspace host on the Compose machine:

1. Signed in as an Admin, open **Workspace settings > Connect runtime > Add runtime host**, give it a name and copy the command.
2. Take the claim URL at its end (`https://spyria.example.com/h/<code>`), replace its origin with `http://server:3000`, and put it in `SPYRIA_HOST_CLAIM_URL`: `http://server:3000/h/<code>`.
3. Add `host` to `COMPOSE_PROFILES` (and set `SPYRIA_DOCKER_GROUP` on Linux), then run the same `up -d --build`.

The host pairs once and keeps its token in the `<deployment>-host` volume; the claim URL is not used again. Do not also run the copied command on this machine: it would replace the Compose container, which has the same name.

### Other machines

A host on another machine (a second workspace host, or a member's own machine) needs two images on its Docker daemon, because nothing is pulled:

- the host image, named after the deployment: `docker build -t spyria-prod-host apps/host` from a clone of the same version;
- the runtime image with the exact content ID in the server's `apps/agent/image-id`. Building it again elsewhere may give another ID; copying it keeps it, for example `docker save <image id> | ssh <machine> docker load` (same CPU architecture only).

Then run the command the app shows. It adapts to rootless or rooted Docker by itself.

### Many runtimes on one host

Each running runtime gets its own Docker bridge network, released when the runtime stops, so runtimes on one host cannot reach each other where Docker's isolation rules apply (Docker Engine on Linux). Docker's default address pools hold about 30 such networks per daemon. A host meant to run more than about 25 runtimes at once needs smaller pools in `/etc/docker/daemon.json`, then a Docker restart:

```json
{ "default-address-pools": [{ "base": "10.200.0.0/16", "size": 28 }] }
```

That gives 4,096 networks.

### Egress

Spyria does not filter runtimes' outbound traffic. On a cloud machine, block the metadata endpoint (`169.254.169.254`) and private address ranges in the provider's firewall, so an agent cannot read the machine's cloud credentials or reach internal services.

## GitHub App (dev chats)

Each deployment registers its own GitHub App. An Admin opens **Workspace settings > Connect GitHub**:

- **Create the GitHub App on GitHub** (on your account or an organization) sends GitHub a manifest with Spyria's permissions (contents, pull requests and workflows write, issues, checks, actions and metadata read), its events (pull requests, reviews, review comments and threads, check suites and runs) and its URLs, all computed from the origin. GitHub creates the App, Spyria stores its credentials sealed with `SPYRIA_SECRETS_KEY`, and GitHub asks which repositories to install it on.
- **Create it manually** keeps the steps and a form as a fallback, for example on a GitHub Enterprise server without manifests: the App id, the client id, the private key, the client secret and the webhook secret. Secrets are shown only as set and replaced by entering a new value.

Webhooks arrive on `/api/github/webhooks`; Spyria checks each delivery's `X-Hub-Signature-256` with the webhook secret and ignores a delivery id it already received. The server image includes `git`: publishing runs on the server, which pushes a git bundle from the runtime with the chat owner's own token. Members link their GitHub account in their profile. See [dev mode](../features/dev-mode.md).

## Tool servers in the gateway

Members connect tools (MCP servers) in **Profile > Connections**; their OAuth tokens stay in the gateway. A tool server is set up once per deployment by an operator before members see it. The setup prints a login URL: log in once with your own account (the gateway uses it only to discover the server's tools), approve, then press Enter. When a member connects, Spyria first deletes the member's sign-in to that server and checks none is left, then starts a new one by calling a tool the server marks read-only, or its first tool when it marks none. With no sign-in, the gateway asks for one before the call reaches the server.

- **GitHub:** create a GitHub OAuth App with the callback URL `<origin>/gateway-oauth/api/oauth/callback`, then run:

  ```sh
  docker compose --env-file .env.prod -f deploy/compose.prod.yml exec \
    -e GITHUB_MCP_CLIENT_ID=<client id> -e GITHUB_MCP_CLIENT_SECRET=<client secret> \
    server bun apps/server/src/operator-cli.ts tools-setup github
  ```

  The scopes are `repo read:org read:user`. The secret goes to the gateway, encrypted there, never to Spyria's database.
- **Notion:** nothing to register:

  ```sh
  docker compose --env-file .env.prod -f deploy/compose.prod.yml exec server bun apps/server/src/operator-cli.ts tools-setup notion
  ```

## Upgrading

```sh
git pull
bun run agent:build
docker compose --env-file .env.prod -f deploy/compose.prod.yml up -d --build
```

The `migrate` service applies new migrations, and the server starts only after it succeeded. A new runtime image applies to new runtimes; running ones keep theirs. Rebuild the host image on other host machines from the same version. More in [operations](./operations.md#upgrades-and-migrations).

## Checking the Compose file

```sh
bun run agent:build
bun run smoke:prod
```

`smoke:prod` starts the production Compose file under a throwaway name (`spyria-smoke-<random>`) with generated secrets, waits for every healthcheck, checks `/health`, the web app's `index.html` and a hashed asset with their cache headers, and that `/auth/mode` offers creating the first workspace. It then removes the containers, volumes, network and every image it built, even on failure. It does not start the optional profiles, and it takes a few minutes.

## Example: Cloudflare

One way to get an HTTPS origin, an OIDC provider, a mailbox and SMTP without opening a port, using Cloudflare Tunnel, Access and Email Routing with Resend for SMTP. Any equivalent works. The Compose file has an optional `cloudflare` profile that runs the tunnel connector (`<deployment>-cloudflared`) on the Compose network.

1. **Tunnel.** Cloudflare Zero Trust > Networks > Tunnels > Create a tunnel (cloudflared). Copy its token to `CLOUDFLARE_TUNNEL_TOKEN` in `.env.prod`, add `cloudflare` to `COMPOSE_PROFILES` and start the stack: Cloudflare saves routes only once a connector runs. Then add the public hostnames in this order:
   - `spyria.example.com` with path `^/zero/` to `http://zero-cache:4848`;
   - `spyria.example.com` without a path to `http://server:3000`.

   Set `SPYRIA_TRUSTED_PROXY=cloudflare` so rate limits key on Cloudflare's `CF-Connecting-IP` header. Only do this when the server is reachable through Cloudflare alone, or clients could choose their own address.
2. **Mailbox.** Email > Email Routing on the domain: forward an address such as `admin@example.com` to your inbox. It receives the domain verification link and Access one-time PINs.
3. **OIDC through Access.** Zero Trust > Access > Applications > Add an application > SaaS, OIDC, redirect URL `https://spyria.example.com/auth/callback`, and a policy allowing emails ending in `@example.com`. Add **One-time PIN** as a login method (or your identity provider) and select it on the application. In **Create a workspace**, choose **Other OIDC** with the issuer `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`, the client id and the client secret Access shows.
4. **SMTP through Resend.** Add the domain in Resend and create the DNS records it lists in Cloudflare DNS: the `send` MX and SPF TXT, the `resend._domainkey` DKIM TXT, and a DMARC TXT if you have none. They do not touch Email Routing's MX. Then:

   ```sh
   SPYRIA_SMTP_URL=smtps://resend:<API key>@smtp.resend.com:465
   SPYRIA_MAIL_FROM=Spyria <spyria@example.com>
   ```

Pitfalls specific to this setup:

- **`502` with a TLS error in cloudflared:** the tunnel routes use `https://`; use `http://server:3000` and `http://zero-cache:4848`.
- **Access asks for a Cloudflare password:** One-time PIN (or your identity provider) is not selected on the Access application.
- **Access says "The account does not have access":** an existing Cloudflare session in the browser; sign in from a private window.

## Common pitfalls

| Symptom | Cause and fix |
|---|---|
| The server keeps restarting | The production check failed; read `logs server` for the list. |
| `502` from the proxy | The proxy forwards to `https://`. The services speak plain HTTP on the Compose network: use `http://server:3000` and `http://zero-cache:4848`. |
| The app loads but never syncs | `/zero/*` is not routed to zero-cache, the catch-all route comes before the `/zero` one, or the proxy drops WebSocket upgrades. |
| A prompt says "Spyria's runtime image is not built" or the host says the image is missing | Run `bun run agent:build` (on another machine, load the same image), then restart the server. |
| The host profile cannot reach Docker | `SPYRIA_DOCKER_GROUP` is not the group of `/var/run/docker.sock` (Linux), or Docker runs rootless. |
| Invites are refused, or invited people are told no workspace invited them | The domain is not verified yet; send and open the link from **Workspace settings > Setup SSO**, or use `sso:verify-domain`. |
| SSO client secrets or GitHub App keys stop working | `SPYRIA_SECRETS_KEY` changed. Restore it; otherwise enter every secret again. |
| Members' API keys stop working | `SPYRIA_GATEWAY_ENCRYPTION_KEY` changed. Restore it; otherwise wipe the gateway's database and have members add their keys again. |
| Runtimes stop starting after many chats | The host ran out of Docker address pools; see [Many runtimes on one host](#many-runtimes-on-one-host). |

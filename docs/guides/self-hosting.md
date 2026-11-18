# Manual install

Spyria runs as one Docker Compose file on one machine: Postgres, the migrations, the server with the web app, zero-cache, the model gateway and its database, and optionally a runtime host. This guide installs it by hand and shows what [`spyria setup`](./install.md) does underneath.

See also [troubleshooting](./troubleshooting.md), [operations](./operations.md) (logs, traces, health, backups, disk) and the [architecture overview](../architecture/overview.md).

## What you need

- **Docker with Compose**, on any server at home or at a provider. Images are on GHCR for `amd64` and `arm64`, signed with cosign (`spyria-server`, `spyria-host`, `spyria-agent`).
- **An HTTPS origin**, for example `https://spyria.example.com`. The server refuses to start in production without `https://`.
- **A reverse proxy or tunnel that terminates TLS** (Caddy, nginx, Traefik, a tunnel service). See [Path routing](#path-routing).
- **At least one sign-in provider**: Google, Microsoft or any OIDC provider for accounts, or the first workspace's own provider. Production sign-in is single sign-on only.
- **A GitHub App**, later and from the app, only for dev chats on repositories.

## Install

1. Download three files from the release you run (`v1.0.0` here):

   ```sh
   mkdir spyria && cd spyria
   curl -fsSLO https://raw.githubusercontent.com/Camil-H/spyria/v1.0.0/deploy/compose.prod.yml
   curl -fsSLO https://raw.githubusercontent.com/Camil-H/spyria/v1.0.0/deploy/bifrost.json
   curl -fsSL https://raw.githubusercontent.com/Camil-H/spyria/v1.0.0/.env.example -o .env.prod
   ```

2. Fill every key marked `[prod]` in `.env.prod`, with `SPYRIA_VERSION=1.0.0` and a [deployment name](#deployment-name) of its own ([Configuration](#configuration-envprod)).
3. Set an [account provider](#account-providers), or register a client at your organization's provider with the redirect URI `<origin>/auth/callback`.
4. Optional: verify an image's signature (keyless, from the repository's Publish workflow):

   ```sh
   cosign verify ghcr.io/camil-h/spyria-server:1.0.0 \
     --certificate-identity-regexp '^https://github.com/Camil-H/spyria/' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

5. Start the stack:

   ```sh
   docker compose --env-file .env.prod -f compose.prod.yml pull
   docker compose --env-file .env.prod -f compose.prod.yml up -d
   ```

6. Check each service's healthcheck with `docker compose --env-file .env.prod -f compose.prod.yml ps`. If the server exits, see [What the server checks at start](#what-the-server-checks-at-start).
7. Point your proxy or tunnel at `server:3000` ([Path routing](#path-routing)).
8. Create the [first workspace](#first-workspace-and-sign-in).
9. Optional: add a [runtime host on this machine](#runtime-host-on-this-machine) and the [GitHub App](#github-app-dev-chats).

Good to know:

- Start order: Postgres, `migrate` (one-shot), `gateway-database` (one-shot, creates the gateway's role and database), the gateway, the server (once migrations succeeded and the gateway is healthy), zero-cache.
- The server's `/health` checks `zero` and `gateway`, among others.
- The server names its version's runtime image by digest (`ghcr.io/camil-h/spyria-agent@sha256:…`: Pi, node, git, ripgrep, poppler-utils). Each host pulls it on first need, so the first runtime on a host waits for the pull. A host accepts no other image from the server, except a local content ID.

## First workspace and sign-in

Sign-in rules: [who can join and sign-in](./who-can-join.md), [security](../architecture/security.md), [admin settings](../features/admin.md#sign-in-and-sso).

1. Open the setup link `<origin>/?setup=<SPYRIA_SETUP_TOKEN>`. `spyria setup` prints it, or run `operator-cli.ts setup-link` in the server container ([operations](./operations.md#first-workspace)).
2. Choose **Create a workspace** and enter its name.
3. Pick an account provider, or your organization's provider: Google Workspace, Microsoft Entra (with its tenant id), or **Other OIDC** (with an issuer), which the workspace then enforces. Spyria checks the discovery document and encrypts the client secret, which it never shows again.
4. Complete the provider's sign-in. You become the Admin.

Good to know:

- Without the setup link, a fresh deployment only says it is being set up, so nobody can claim it before you.
- Afterwards, anyone signed in with an account can create their own workspace. Without account providers, nobody can.

## Deployment name

`SPYRIA_DEPLOYMENT` names the Compose project and prefixes every Docker object of the deployment, including those the app creates on runtime hosts. With `SPYRIA_DEPLOYMENT=spyria-prod`:

| Object | Name |
|---|---|
| Compose containers | `spyria-prod-postgres`, `spyria-prod-migrate`, `spyria-prod-server`, `spyria-prod-zero-cache`, `spyria-prod-gateway-database`, `spyria-prod-gateway`, `spyria-prod-host`, `spyria-prod-cloudflared` |
| Volumes | `spyria-prod-postgres-data`, `spyria-prod-zero-data`, `spyria-prod-gateway-data`, `spyria-prod-host` |
| Network | `spyria-prod-network` |
| Images built from a clone | `spyria-prod-server` (server and migrations), `spyria-prod-host` |
| On runtime hosts | runtimes `spyria-prod-rt-*`, harness sign-ins `spyria-prod-cred-*`, harness installs `spyria-prod-harnesses` |

Two deployments can share one Docker daemon without seeing each other's runtimes. Give production its own name: the default `spyria` is the development stack's.

## Path routing

`server:3000` serves the whole origin: the web app, `/api`, `/auth`, `/h/<code>` (host claim links), `/host`, `/gateway-oauth`, `/api/github/webhooks`, `/health`, and `/zero/*` (forwarded to zero-cache). Your proxy must:

- terminate TLS and forward plain HTTP to `server:3000`;
- pass WebSocket upgrades (`/zero/`, `/host`, `/api/stream`) and keep long-lived connections open;
- never route to the gateway (`gateway:8080`): its admin API returns tool servers' header secrets in plain text. Compose publishes no gateway port; the server forwards only `/gateway-oauth/api/oauth/callback` to it.

Good to know:

- The server is reachable only on `<deployment>-network`, so run the proxy or tunnel connector as a container on that network.
- It also answers on `127.0.0.1:${SPYRIA_LOCAL_PORT:-3300}`, for health checks and a local proxy.
- Run one server instance: agent streams, host connections and rate limits live in its process.

## Configuration: `.env.prod`

Compose reads only the keys of `.env.example` marked `[prod]`. It sets the gateway URL, the redirect URI (`<origin>/auth/callback`), the auth mode (`sso`) and `SPYRIA_ENV=production` itself.

- Secrets: letters and digits only (the Postgres password goes into a URL), for example `openssl rand -hex 32`.
- Any secret can come from a file: `<NAME>_FILE` holding its path ([secrets in files](./operations.md#secrets-in-files)). When to replace each: [rotation intervals](./operations.md#rotation-intervals).

| Key | Purpose |
|---|---|
| `SPYRIA_DEPLOYMENT` | [Deployment name](#deployment-name): lowercase letters, digits, dashes. |
| `SPYRIA_VERSION` | Release tag without `v`, for example `1.0.0`. Required. |
| `SPYRIA_IMAGES` | Image registry and namespace, default `ghcr.io/camil-h`. Only for a fork's own published images (its server and host use that namespace alone); a mirror of the originals does not work. |
| `SPYRIA_APP_ORIGIN` | Public origin, `https://`. |
| `SPYRIA_TOKEN_SECRET` | Signs session tokens. At least 32 characters. |
| `SPYRIA_SETUP_TOKEN` | At least 32 characters. Only the setup link carrying it creates the first workspace; spent once one exists. |
| `SPYRIA_SECRETS_KEY` | At least 32 characters. Encrypts stored secrets (SSO client secrets, GitHub App keys) with AES-GCM and derives the key that reaches each runtime. Never change it directly, or stored secrets must be re-entered: [rotate it](./operations.md#rotating-the-secrets-key). |
| `SPYRIA_PREVIOUS_SECRETS_KEYS` | Only while [rotating](./operations.md#rotating-the-secrets-key): previous keys, comma-separated. Still open what they sealed and reach runtimes started with them; seal nothing new. |
| `SPYRIA_TRUSTED_PROXY` | Leave unset, except `cloudflare` ([example](#example-cloudflare)) or `x-forwarded-for:<hops from the end>` behind a load balancer that appends the client and is the only way in (cloud modules set it). Otherwise rate limits on unauthenticated routes see every client as the proxy. |
| `SPYRIA_GOOGLE_CLIENT_ID`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_ID`, `SPYRIA_MICROSOFT_CLIENT_SECRET` | Optional [account providers](#account-providers). |
| `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID`, `SPYRIA_OIDC_CLIENT_SECRET` | Optional other OIDC account provider; all three or none. |
| `SPYRIA_GATEWAY_ADMIN_USER`, `SPYRIA_GATEWAY_ADMIN_PASSWORD` | Gateway admin login. |
| `SPYRIA_GATEWAY_ENCRYPTION_KEY` | Encrypts members' API keys in the gateway. Never change it without wiping the gateway's database. |
| `SPYRIA_GATEWAY_SETUP_TOKEN` | Gateway setup token. |
| `SPYRIA_GATEWAY_DB_PASSWORD` | Gateway database role password. |
| `SPYRIA_POSTGRES_PASSWORD` | `spyria` database role password, set on first start and kept in the Postgres volume. |
| `SPYRIA_ZERO_ADMIN_PASSWORD` | zero-cache admin password. |
| `SPYRIA_LOCAL_PORT` | Server's loopback port, default `3300`. |
| `COMPOSE_PROFILES` | Optional services, comma-separated: `host`, `cloudflare`. |
| `SPYRIA_INSTALL_HOST_TOKEN` | Optional: one-time code pairing this machine's host before the first workspace exists. |
| `SPYRIA_HOST_CLAIM_URL` | Profile `host`: the [claim URL](#runtime-host-on-this-machine), passed in the environment so other users cannot read it in `ps`. |
| `SPYRIA_DOCKER_GROUP` | Profile `host`: Docker socket group, `0` on macOS (default), `stat -c %g /var/run/docker.sock` on Linux. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Profile `cloudflare`: the tunnel's token. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Optional OTLP export of traces and logs ([operations](./operations.md#traces)). |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Trace sampling, default 10% of new traces. |

### Compose profiles

| Profile | Adds | Needs |
|---|---|---|
| `host` | `<deployment>-host`, a workspace runtime host on this machine's Docker: read-only, all capabilities dropped, `no-new-privileges` | `SPYRIA_HOST_CLAIM_URL`; `SPYRIA_DOCKER_GROUP` on Linux |
| `cloudflare` | `<deployment>-cloudflared`, the Cloudflare Tunnel connector | `CLOUDFLARE_TUNNEL_TOKEN` |

### What the server checks at start

With `SPYRIA_ENV=production` (set by the image), the server refuses to start on a bad setting and prints `Spyria cannot start in production:` with one line per problem. Read them with `docker compose --env-file .env.prod -f compose.prod.yml logs server`. It checks that:

- `SPYRIA_AUTH_MODE` is `sso`;
- `SPYRIA_TOKEN_SECRET`, `SPYRIA_SECRETS_KEY` and `SPYRIA_SETUP_TOKEN` have at least 32 characters and are not a development default (`spyria` or `spyria-dev-…`);
- `SPYRIA_APP_ORIGIN` starts with `https://` and `SPYRIA_OIDC_REDIRECT_URI` is on it;
- `SPYRIA_GATEWAY_URL`, `SPYRIA_GATEWAY_ADMIN_USER` and `SPYRIA_GATEWAY_ADMIN_PASSWORD` are set, the login not a development default;
- `SPYRIA_INSTALL_HOST_TOKEN`, if set, is 16 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`;
- the three `SPYRIA_OIDC_*` keys are all set or none;
- `SPYRIA_TRUSTED_PROXY` is unset, `cloudflare`, or `x-forwarded-for:1` to `3`.

## From a clone

Runs images built on the machine (your own build, or `bun run smoke:prod`). Needs Bun.

```sh
bun install && bun run agent:build
docker compose --env-file .env.prod -f deploy/compose.prod.yml -f deploy/compose.build.yml up -d --build
```

- `deploy/compose.build.yml` builds the server and host images and mounts the runtime image's content ID from `apps/agent/image-id` (written by `bun run agent:build`).
- Hosts then accept only that content ID: every host needs the same local build.
- `SPYRIA_VERSION` is still required; any value works.

## Account providers

Apps of the deployment that people sign in to their account with. Each uses the redirect URI `<origin>/auth/callback`.

- **Google**: in Google Cloud, create an OAuth client of type *Web application* and an *External* consent screen with `openid`, `email` and `profile`. Set `SPYRIA_GOOGLE_CLIENT_ID` and `SPYRIA_GOOGLE_CLIENT_SECRET`. Any Google account signs in, Gmail included.
- **Microsoft**: in Microsoft Entra, register an app for *Accounts in any organizational directory and personal Microsoft accounts* with a web redirect URI, and create a client secret. Set `SPYRIA_MICROSOFT_CLIENT_ID` and `SPYRIA_MICROSOFT_CLIENT_SECRET`. A tenant that blocks user consent needs its Entra admin to consent on the first sign-in.
- **Other OIDC**: register a client with scopes `openid`, `email` and `profile`; set `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID` and `SPYRIA_OIDC_CLIENT_SECRET`. It must send `email_verified: true` ([decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)).

Good to know:

- A workspace enforcing Google Workspace or Microsoft Entra can use the deployment's Google or Microsoft app instead of its own client. Through Google it admits only accounts managed by their domain's Google Workspace, plus Gmail; through Microsoft, only its own tenant.
- The server refuses to start, naming the provider, while a workspace uses an app whose variables are missing. Set them again rather than removing them.

## Runtime host on this machine

Runtime hosts are machines with Docker running `spyria-host`, which dials out to Spyria ([machines](../features/machines.md)).

What `spyria setup` does: it generates a one-time install code (`SPYRIA_INSTALL_HOST_TOKEN`), points the host at `http://server:3000/h/<code>` and adds the `host` profile. Once the first workspace exists, the host appears in **Workspace settings** as **This machine**, removable like any host. The code works once, for the first workspace only; later, `spyria setup --host` asks for the command of **Add runtime host** and uses its code.

By hand:

1. Get a code:
   - before the first workspace: set `SPYRIA_INSTALL_HOST_TOKEN` to 16 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`;
   - after: as an Admin, open **Workspace settings > Runtimes > Add runtime host**, name it, copy the command and take the `<code>` from the claim URL at its end (`https://spyria.example.com/h/<code>`).
2. Set `SPYRIA_HOST_CLAIM_URL=http://server:3000/h/<code>`.
3. Add `host` to `COMPOSE_PROFILES` (and set `SPYRIA_DOCKER_GROUP` on Linux), then run `pull` and `up -d` again.

Good to know:

- The host pairs once and keeps its token in the `<deployment>-host` volume.
- Do not also run the copied command on this machine: it would replace the Compose container of the same name.

### Other machines

Another host (a second workspace host, or a member's machine) runs the command the app shows.

- It pulls the host image of the deployment's version (`ghcr.io/camil-h/spyria-host:1.0.0`) and adapts to rootless or rooted Docker.
- It pulls the runtime image by digest when its first runtime starts.
- A deployment [built from a clone](#from-a-clone) needs both images on every host: `docker build -t spyria-prod-host apps/host` from the same version, and the runtime image with the exact content ID in `apps/agent/image-id`. A rebuild may change the ID; `docker save <image id> | ssh <machine> docker load` keeps it (same CPU architecture only).

### Many runtimes on one host

Each running runtime gets its own Docker bridge network, so runtimes cannot reach each other where Docker's isolation applies (Docker Engine on Linux). Default address pools allow about 30 networks per daemon.

For more than about 25 runtimes at once, set smaller pools in `/etc/docker/daemon.json` (4,096 networks) and restart Docker:

```json
{ "default-address-pools": [{ "base": "10.200.0.0/16", "size": 28 }] }
```

### Behind an outbound proxy

- Set `HTTPS_PROXY` (`HTTP_PROXY` for an `http://` origin) and `NO_PROXY` in the shell before running the host command; it passes them on.
- Only the connection to Spyria uses the proxy: not relayed runtime calls, not the host's health check. Runtimes get no proxy settings.

### Relay limits

- HTTP bodies between server and runtime: up to 256 MiB, relayed in 256 KiB base64 chunks.
- A runtime's event stream: 1 MiB sent ahead of acknowledgements; the host closes that stream if it holds more than 8 MiB.
- A host too old for this relay is refused, with the command that updates it.

### Egress

Spyria does not filter runtimes' outbound traffic. On a cloud machine, block the metadata endpoint (`169.254.169.254`) and private address ranges in the provider's firewall.

## GitHub App (dev chats)

Each deployment registers its own App, in **Workspace settings > GitHub**:

- **Create the GitHub App on GitHub** (personal account or organization) sends a manifest built from the origin. Permissions: contents, pull requests and workflows write; issues, checks, actions and metadata read. Events: pull requests, reviews, review comments and threads, check suites and runs. Spyria stores the credentials sealed with `SPYRIA_SECRETS_KEY`, and GitHub asks which repositories to install it on.
- **Create it manually** is the fallback (for example GitHub Enterprise without manifests): enter the App id, client id, private key, client secret and webhook secret.

Good to know:

- Secrets show only as set; replace them under **Edit credentials**. **Create a new App** replaces the connected App.
- Webhooks arrive on `/api/github/webhooks`, checked with `X-Hub-Signature-256`; repeated delivery ids are ignored.
- The server image includes `git`: the server pushes a bundle from the runtime with the chat owner's token.
- Members link their GitHub account in their profile ([dev mode](../features/dev-mode.md)).

## Tool servers in the gateway

Nothing to set up per deployment. Admins add tool servers (MCP) in **Workspace settings > Tools**, members connect in **Profile > Connections**, and OAuth tokens stay in the gateway ([Admin](../features/admin.md#tools)).

- OAuth redirects go through `<origin>/gateway-oauth/api/oauth/callback`.
- A server must support OAuth dynamic client registration (Notion's does). One needing a pre-registered OAuth app, such as GitHub's, cannot be added yet.
- On connect, Spyria clears the member's previous sign-in to that server, then starts a new one by calling a tool they may use (read-only when the server marks any).

## Deleting a workspace

An Admin deletes a workspace from **Workspace settings** ([Administration](../features/admin.md#deleting-the-workspace)). Members lose access at once; seven days later a job erases it: it removes its runtimes through the hosts, its keys and tool servers from the gateway, then its rows.

To restore it, or erase it now, during those seven days:

```sh
docker compose --env-file .env.prod -f compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts workspace:restore <workspace id>
docker compose --env-file .env.prod -f compose.prod.yml exec server \
  bun apps/server/src/operator-cli.ts workspace:purge <workspace id> [--abandon-failed-cleanup]
```

Good to know:

- After deletion, nothing new starts for the workspace; runtimes still starting are removed a few minutes later. Hosts stay connected until the erase is done.
- If a cleanup job keeps failing (for example a host stays offline), the erase waits so no keys stay in the gateway. It logs `workspace.purge_blocked` and retries hourly; bring the host back and it goes through.
- `--abandon-failed-cleanup` erases anyway: it drops cleanup jobs that failed or await a retry after failing (not running ones, nor ones that never failed) and prints what is left behind.
- A restore is refused once the erase has started.
- Once the last workspace is erased, the setup link creates the next one.

## Upgrading

Set `SPYRIA_VERSION` in `.env.prod` to the new release, then run the same `pull` and `up -d`.

- `migrate` applies new migrations before the server starts.
- Hosts use the new runtime image from their next runtime start; running runtimes keep theirs until they stop.
- Hosts on other machines show **Update available**, or **Update needed** (refused) when the release raised the minimum protocol, with the command that updates them.
- More in [operations](./operations.md#upgrades-and-migrations).

## Checking the Compose file

From a clone, `bun run agent:build` then `bun run smoke:prod` (a few minutes). It runs the production file with `compose.build.yml` under a throwaway name (`spyria-smoke-<random>`) and generated secrets, then checks:

- every healthcheck and `/health`;
- `index.html` and a hashed asset, with cache headers;
- `/auth/mode` reports setup, and offers the first workspace only with the setup token;
- `/zero` reaches zero-cache through the server (HTTP and WebSocket).

It removes everything it created, even on failure, and skips the optional profiles.

## Example: Cloudflare

An HTTPS origin and an organization provider without opening a port. Any equivalent works.

1. **Tunnel.** Zero Trust > Networks > Tunnels: create a tunnel (cloudflared). Put its token in `CLOUDFLARE_TUNNEL_TOKEN`, add `cloudflare` to `COMPOSE_PROFILES`, and start the stack (routes save only once a connector runs). Add one public hostname, `spyria.example.com` without a path, to `http://server:3000`.
2. **Trusted proxy.** Set `SPYRIA_TRUSTED_PROXY=cloudflare` so rate limits use `CF-Connecting-IP`. Only if Cloudflare is the only way in, or clients could choose their own address.
3. **Mailbox.** Email > Email Routing: forward an address such as `admin@example.com` to your inbox, for the Access one-time PINs.
4. **OIDC through Access.** Zero Trust > Access > Applications > Add an application > SaaS: OIDC, redirect URL `https://spyria.example.com/auth/callback`, a policy allowing emails ending in `@example.com`. Add **One-time PIN** (or your identity provider) as a login method and select it on the application.
5. **Workspace.** In **Create a workspace**, choose **Other OIDC** with issuer `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>` and the client id and secret from Access.

Pitfalls:

- **`502` with a TLS error in cloudflared:** the route uses `https://`; use `http://server:3000`.
- **Access asks for a Cloudflare password:** One-time PIN (or your identity provider) is not selected on the application.
- **"The account does not have access":** an existing Cloudflare session; use a private window.

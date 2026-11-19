# Manual install

Most installs use [`spyria setup`](./install.md), which can serve HTTPS itself or through a Cloudflare tunnel. Use this page to run Spyria behind your own reverse proxy, or to see what setup does underneath.

Spyria runs as one Docker Compose file on one machine: Postgres, the migrations, the server with the web app, zero-cache, the model gateway and its database, and optionally a runtime host.

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
3. Set an [account provider](#account-providers), or plan to use your organization's own provider for the first workspace.
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
8. Create the first workspace: see [after setup](#after-setup).

The other guides write `spyria compose`; on this install, define this alias and use it instead:

```sh
alias spyria-compose='docker compose --env-file .env.prod -f compose.prod.yml'
```

Good to know:

- Start order: Postgres, `migrate` (one-shot), `gateway-database` (one-shot, creates the gateway's role and database), the gateway, the server (once migrations succeeded and the gateway is healthy), zero-cache.
- The server's `/health` checks `zero` and `gateway`, among others.
- The server names its version's runtime image by digest (`ghcr.io/camil-h/spyria-agent@sha256:…`: Pi, node, git, ripgrep, poppler-utils). Each host pulls it on first need, so the first runtime on a host waits for the pull. A host accepts no other image from the server, except a local content ID.

## After setup

Open the setup link `<origin>/?setup=<SPYRIA_SETUP_TOKEN>` and create the first workspace by signing in. To print it again, run `spyria-compose exec server bun apps/server/src/operator-cli.ts setup-link`.

To run agents on this machine, take the code from the claim URL of **Workspace settings › Runtimes › Add runtime host** (`https://<hostname>/h/<code>`), set `SPYRIA_HOST_CLAIM_URL=http://server:3000/h/<code>`, add `host` to `COMPOSE_PROFILES` (and set `SPYRIA_DOCKER_GROUP` on Linux), then run `pull` and `up -d` again. Do not run the copied command on this machine: it would replace the Compose container of the same name.

## Account providers

Apps people sign in to their account with ([who can join and sign-in](./who-can-join.md)). Each is optional and uses the redirect URI `<origin>/auth/callback`.

- **Google**: an OAuth client of type *Web application* with an *External* consent screen and the scopes `openid`, `email` and `profile` (any Google account, Gmail included): `SPYRIA_GOOGLE_CLIENT_ID` and `SPYRIA_GOOGLE_CLIENT_SECRET`.
- **Microsoft**: an app in Microsoft Entra for *Accounts in any organizational directory and personal Microsoft accounts*, with a web redirect URI and a client secret: `SPYRIA_MICROSOFT_CLIENT_ID` and `SPYRIA_MICROSOFT_CLIENT_SECRET`. A tenant that blocks user consent needs its Entra admin to consent on the first sign-in.
- **OIDC provider**: a client with the scopes `openid`, `email` and `profile`, which must confirm addresses (`email_verified: true`, [decision 0028](../decisions/0028-generic-oidc-must-confirm-addresses.md)): `SPYRIA_OIDC_ISSUER`, `SPYRIA_OIDC_CLIENT_ID` and `SPYRIA_OIDC_CLIENT_SECRET`.
- With none, people sign in only through the first workspace's own provider, and nobody can create more workspaces.

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
- Any secret can come from a file: `<NAME>_FILE` holding its path ([secrets in files](./security.md#secrets-in-files)). When to replace each: [rotation intervals](./security.md#rotation-intervals).

| Key | Purpose |
|---|---|
| `SPYRIA_DEPLOYMENT` | [Deployment name](#deployment-name): lowercase letters, digits, dashes. |
| `SPYRIA_VERSION` | Release tag without `v`, for example `1.0.0`. Required. |
| `SPYRIA_IMAGES` | Image registry and namespace, default `ghcr.io/camil-h`. Only for a fork's own published images (its server and host use that namespace alone); a mirror of the originals does not work. |
| `SPYRIA_APP_ORIGIN` | Public origin, `https://`. |
| `SPYRIA_TOKEN_SECRET` | Signs session tokens. At least 32 characters. |
| `SPYRIA_SETUP_TOKEN` | At least 32 characters. Only the setup link carrying it creates the first workspace; spent once one exists. |
| `SPYRIA_SECRETS_KEY` | At least 32 characters. Encrypts stored secrets (SSO client secrets, GitHub App keys) with AES-GCM and derives the key that reaches each runtime. Never change it directly, or stored secrets must be re-entered: [rotate it](./security.md#rotating-the-secrets-key). |
| `SPYRIA_PREVIOUS_SECRETS_KEYS` | Only while [rotating](./security.md#rotating-the-secrets-key): previous keys, comma-separated. Still open what they sealed and reach runtimes started with them; seal nothing new. |
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
| `COMPOSE_PROFILES` | Optional services, comma-separated: `host`, `cloudflare`, `direct`. |
| `SPYRIA_HTTPS` | Written by `spyria setup`: `tunnel` or `direct`, the answer it keeps when run again. |
| `SPYRIA_INSTALL_HOST_TOKEN` | Optional: one-time code pairing this machine's host before the first workspace exists. |
| `SPYRIA_HOST_CLAIM_URL` | Profile `host`: `http://server:3000/h/<code>`, with the code from the claim URL of **Add runtime host**, passed in the environment so other users cannot read it in `ps`. |
| `SPYRIA_DOCKER_GROUP` | Profile `host`: Docker socket group, `0` on macOS (default), `stat -c %g /var/run/docker.sock` on Linux. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Profile `cloudflare`: the tunnel's token. |
| `SPYRIA_ACME_EMAIL` | Profile `direct`: optional contact address for Let's Encrypt, which issues the HTTPS certificate. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Optional OTLP export of traces and logs ([operations](./operations.md#traces)). |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Trace sampling, default 10% of new traces. |

### Compose profiles

| Profile | Adds | Needs |
|---|---|---|
| `host` | `<deployment>-host`, a workspace runtime host on this machine's Docker: read-only, all capabilities dropped, `no-new-privileges` | `SPYRIA_HOST_CLAIM_URL`; `SPYRIA_DOCKER_GROUP` on Linux |
| `cloudflare` | `<deployment>-cloudflared`, the Cloudflare Tunnel connector | `CLOUDFLARE_TUNNEL_TOKEN` |
| `direct` | `<deployment>-caddy` on ports 80 and 443, with a Let's Encrypt certificate kept in `<deployment>-caddy-data` (not backed up: Caddy gets a new one) | The release's `deploy/Caddyfile` next to the Compose file; DNS pointing at the machine; `SPYRIA_TRUSTED_PROXY=x-forwarded-for:1` |

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
- Every runtime host on another machine needs both images: `docker build -t <deployment>-host apps/host` from the same version, and the runtime image with the exact content ID in `apps/agent/image-id`. A rebuild may change the ID; `docker save <image id> | ssh <machine> docker load` keeps it (same CPU architecture only).

## Upgrading

1. Take a [backup](./operations.md#backups).
2. Set `SPYRIA_VERSION` in `.env.prod` to the new release.
3. Replace `compose.prod.yml` and `bifrost.json` with the release's.
4. Run `spyria-compose pull`, then `spyria-compose up -d`.

From a clone: `git pull`, `bun run agent:build`, then:

```sh
docker compose --env-file .env.prod -f deploy/compose.prod.yml -f deploy/compose.build.yml up -d --build
```

From a clone, also rebuild the image of hosts on other machines and load the new runtime image there; hosts using the published images pull it themselves and show **Update available**. What the upgrade changes (migrations, runtimes, hosts) is the same as with [`spyria upgrade`](./install.md#upgrade).

## Checking the Compose file

From a clone, `bun run agent:build` then `bun run smoke:prod` (a few minutes). It runs the production file with `compose.build.yml` under a throwaway name (`spyria-smoke-<random>`) and generated secrets, then checks:

- every healthcheck and `/health`;
- `index.html` and a hashed asset, with cache headers;
- `/auth/mode` reports setup, and offers the first workspace only with the setup token;
- `/zero` reaches zero-cache through the server (HTTP and WebSocket).

It removes everything it created, even on failure, and skips the optional profiles.

## Example: Cloudflare

One way among others to get an HTTPS origin and an organization provider without opening a port: any reverse proxy or tunnel, and any OIDC provider, work the same way. Cloudflare Access is set up by hand here, as one provider among others; `spyria setup` does not create it.

1. **Tunnel.** Zero Trust > Networks > Tunnels: create a tunnel (cloudflared). Put its token in `CLOUDFLARE_TUNNEL_TOKEN`, add `cloudflare` to `COMPOSE_PROFILES`, and start the stack (routes save only once a connector runs). Add one public hostname, `spyria.example.com` without a path, to `http://server:3000`.
2. **Trusted proxy.** Set `SPYRIA_TRUSTED_PROXY=cloudflare` so rate limits use `CF-Connecting-IP`. Only if Cloudflare is the only way in, or clients could choose their own address.
3. **Mailbox.** Email > Email Routing: forward an address such as `admin@example.com` to your inbox, for the Access one-time PINs.
4. **OIDC through Access.** Zero Trust > Access > Applications > Add an application > SaaS: OIDC, with the redirect URI **Create a workspace** or **Single sign-on** shows (`https://spyria.example.com/auth/callback`), a policy allowing emails ending in `@example.com`. Add **One-time PIN** (or your identity provider) as a login method and select it on the application.
5. **Workspace.** In **Create a workspace**, or later in **Workspace settings › Single sign-on**, choose **Other OIDC** with your own app: issuer `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>` and the client id and secret from Access.

Pitfalls:

- **`502` with a TLS error in cloudflared:** the route uses `https://`; use `http://server:3000`.
- **Access asks for a Cloudflare password:** One-time PIN (or your identity provider) is not selected on the application.
- **"The account does not have access":** an existing Cloudflare session; use a private window.

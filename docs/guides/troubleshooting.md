# Troubleshooting

Start with `spyria doctor`. It checks:

- Docker, each service and its healthcheck;
- the server's start check (the list of settings it refuses);
- the disk and the image versions;
- what exposes the install: a `.env` other users of the machine can read, a missing, default or short credential in it, and a port a service publishes beyond the machine.

`spyria compose logs <service>` shows a service's logs, for example `server`, `zero-cache`, `gateway` or `host`.

## Setup

**`spyria setup` says this machine holds the data of an earlier deployment**

- Cause: the install folder has no `.env` with that deployment's secrets, while its Postgres, zero-cache and gateway volumes are still on the machine. New secrets would not open them.
- Fix: put back the `.env` you copied off the machine with your [backups](./operations.md#backups) and run setup again, or choose another deployment name with `--name`.
- To start over without that data, remove the volumes setup names with `docker volume rm`.

**Docker refuses `spyria setup` on Linux**

- Cause: your user is not in the `docker` group.
- Fix: `sudo usermod -aG docker $(id -un)`, then log out and back in.

**`spyria setup` stops at the Cloudflare step**

- Cause: the API token lacks a permission.
- Fix: give it *Account > Cloudflare Tunnel > Edit*, *Zone > DNS > Edit* and *Zone > Zone > Read*, plus the Access and Email Routing ones for those steps (`spyria --help` lists them).

**The first workspace's link says the deployment is being set up**

- Cause: the link lacks the setup token, or a workspace already exists.
- Fix: `spyria setup-link` prints the link again while no workspace exists.

**With direct HTTPS, setup says Caddy could not get its certificate**

- Cause: the hostname does not point at this machine's public address, or a firewall or the provider closes ports 80 and 443 to the internet. Setup prints Caddy's last certificate error.
- Fix: correct the DNS record or open the ports, then run `spyria setup` again; `spyria compose logs caddy` shows more.

## What `spyria doctor` reports

**`.env` is readable by other users**

- Cause: something rewrote it with a wider mode. Setup and `spyria upgrade` write it readable by you only.
- Fix: `chmod 600 .env` in the install folder.

**A default or short credential**

- Fix for most: set a new value from `openssl rand -hex 32` in `.env`, then `spyria compose up -d`.
- `SPYRIA_SECRETS_KEY`: [rotate it](./security.md#rotating-the-secrets-key), or the stored SSO secrets and GitHub App keys are lost.
- `SPYRIA_GATEWAY_ENCRYPTION_KEY`: changes only with the gateway's database wiped; members then add their API keys again.
- `SPYRIA_POSTGRES_PASSWORD` (role `spyria`) or `SPYRIA_GATEWAY_DB_PASSWORD` (role `bifrost`): Postgres keeps the password it started with, so set the new one there first with `spyria compose exec postgres psql -U spyria`, then `\password spyria` or `\password bifrost`.

**A service publishes a port**

- Cause: a `compose.yml` edited by hand publishes it on every address.
- Fix: publish it on `127.0.0.1` only, or remove it. Cloudflare's tunnel reaches the server without any published port.

## Server and proxy

**The server keeps restarting**

- Cause: the production check failed.
- Fix: `spyria compose logs server` lists every problem; `spyria doctor` shows them too.

**`502` from the proxy**

- Cause: the proxy forwards to `https://`, but the server speaks plain HTTP on the Compose network.
- Fix: forward to `http://server:3000`.

**The app loads but never syncs**

- Cause: the proxy drops WebSocket upgrades on `/zero/`, or zero-cache is down. Then `/health` answers `503` naming `zero`, and the server logs `zero.unreachable`.
- Fix: let the proxy pass WebSocket upgrades on `/zero/`, or bring zero-cache back up.

## Secrets and keys

**SSO client secrets or GitHub App keys stop working**

- Cause: `SPYRIA_SECRETS_KEY` changed without the previous value in `SPYRIA_PREVIOUS_SECRETS_KEYS`.
- Fix: put the previous value there; otherwise enter every secret again. To change the key, [rotate it](./security.md#rotating-the-secrets-key).

**Members' API keys stop working**

- Cause: `SPYRIA_GATEWAY_ENCRYPTION_KEY` changed.
- Fix: restore it; otherwise wipe the gateway's database and have members add their keys again.

## Runtimes and hosts

**A prompt says the runtime image is missing**

- Cause: the host could not pull it; `docker logs <deployment>-host` has the registry's reason.
- Fix: a host built from a clone (no `SPYRIA_IMAGES`) accepts only a local content ID: run `bun run agent:build` there, or load the same image.

**The host profile cannot reach Docker**

- Cause: `SPYRIA_DOCKER_GROUP` is not the group of `/var/run/docker.sock` (Linux), or Docker runs rootless.
- Fix: set `SPYRIA_DOCKER_GROUP` to the output of `stat -c %g /var/run/docker.sock` ([manual install](./self-hosting.md)).

**Runtimes stop starting after many chats**

- Cause: the host ran out of Docker address pools.
- Fix: see [Many runtimes on one host](./self-hosting.md#many-runtimes-on-one-host).

**A runtime host shows "Update needed" and stays offline**

- Cause: its protocol is older than the server's minimum.
- Fix: run the command its badge shows on that machine.

## Sign-in

**"Your provider did not confirm this address"**

- Cause: the provider sent no `email_verified: true` for the address.
- Fix: through a generic OIDC provider, add a claim mapping that sends it ([who can join](./who-can-join.md)). Through Google, the account is not a confirmed one.

**Microsoft sign-in refuses personal accounts or accounts of other organizations**

- Cause: the deployment's Microsoft app is registered for one directory only.
- Fix: in Microsoft Entra, set its supported account types to *Accounts in any organizational directory and personal Microsoft accounts*.

**The address "already signs in with another account"**

- Cause: another account was bound to that address first, at this provider or another.
- Fix: sign in with that account.

## Clouds

**The site answers `503` for a while after a restart**

- Cause: zero-cache rebuilds its replica from Postgres at each start; the server itself stays up (`/health/live`).
- Fix: wait for the rebuild to finish.

**On Azure, the hostname has no HTTPS**

- Fix: run the `certificate_command` output once the DNS records exist ([Azure](./cloud-azure.md#after-setup)).

**On Google Cloud, the certificate stays provisioning**

- Cause: the hostname's `A` record must point at the load balancer's address before Google issues it.
- Fix: point it there; issuing takes up to an hour.

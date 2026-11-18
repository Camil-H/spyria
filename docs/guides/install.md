# Install on one machine

The `spyria` tool installs Spyria with Docker Compose on one machine, reachable over HTTPS through a Cloudflare tunnel or on the machine's own public address.

## What you need

- A Linux machine, a Mac, or a PC under WSL.
- Docker. On Linux the script offers to install Docker Engine with Docker's own script; on a Mac, use Docker Desktop or OrbStack.
- A domain: on your Cloudflare account for the tunnel, or at any DNS provider for direct HTTPS.
- For direct HTTPS only:
  - An A or AAAA record pointing the hostname at the machine's public address.
  - Ports 80 and 443 free on the machine and open to the internet (firewall, provider, router).
  - On rootless Docker, ports below 1024 allowed: `sudo sysctl net.ipv4.ip_unprivileged_port_start=80`, kept after a restart with `echo net.ipv4.ip_unprivileged_port_start=80 | sudo tee /etc/sysctl.d/99-spyria.conf`.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | sh
```

Or the same script from the latest release: `curl -fsSL https://github.com/Camil-H/spyria/releases/latest/download/install.sh | sh`.

The script checks Docker, downloads the `spyria` tool, checks it against the release's checksums, installs it in `~/.local/bin` and runs `spyria setup`.

- When [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) is installed, it also checks that the repository's Publish workflow signed the checksums.
- `SPYRIA_REQUIRE_SIGNATURE=1` refuses to install without cosign.

## What setup asks

1. **Deployment name and install folder** (`spyria` and `~/spyria`).
   - The folder holds `compose.yml`, `bifrost.json`, `.env` (readable by you only, every secret generated) and `backups/`, plus a `Caddyfile` for direct HTTPS.
   - A folder whose `compose.yml` or `.env` belongs to another project is refused.
2. **Hostname**, such as `spyria.example.com`.
3. **How people reach Spyria** (`--https`):
   - `tunnel` (the default): through a Cloudflare tunnel, with no open port. The hostname must be on a domain of your Cloudflare account.
   - `direct`: on this machine's public address. A Caddy container gets a Let's Encrypt certificate and serves ports 80 and 443.
4. **Cloudflare API token** (tunnel only) with *Account > Cloudflare Tunnel > Edit*, *Zone > DNS > Edit* and *Zone > Zone > Read* (My Profile > API Tokens > Create Token > Custom token).
   - The tool creates a tunnel to the server and its DNS record; no port opens on the machine.
   - A hostname with other DNS records (an A or AAAA record of a website, say) is refused: delete them or choose another.
   - The token is never stored.
   - With `direct`, setup instead checks the hostname's A or AAAA record, rootless Docker's lowest port and that ports 80 and 443 are free, and stops before writing anything if one fails.
5. **Account providers** people sign in to their account with, each optional, with the redirect URI `<origin>/auth/callback` the tool shows. With none, people sign in only through the first workspace's own provider ([who can join and sign-in](./who-can-join.md)).
   - **Google**: an OAuth client (any Google account, Gmail included).
   - **Microsoft**: an app for any organizational directory and personal accounts. Answer `create` to register it with `az`; later runs reuse it.
   - **OIDC provider**: issuer URL, client id and secret.
6. **The first workspace's own provider** (optional, `skip` by default). Where the provider has an API and you are an admin there, the tool sets it up and prints what to enter in **Create a workspace** (the client secret only this once). The workspace enforces it.
   - **Cloudflare Access**: set up Zero Trust once in the Cloudflare dashboard first (it picks your team domain). The tool creates an Access application with a one-time PIN for people at your domain. It asks for the Cloudflare token with `direct` too.
     - You sign in as `admin@<domain>` to create the workspace. If the domain receives no mail yet, Email Routing forwards that address to yours (confirm Cloudflare's email first). If it has mailboxes, the tool leaves its mail alone and `admin@<domain>` must be one you read.
     - The token also needs *Account > Access: Apps and Policies > Edit*, *Account > Access: Organizations, Identity Providers, and Groups > Edit*, *Account > Email Routing Addresses > Edit* and *Zone > Email Routing Rules > Edit*.
   - **Microsoft Entra**: an app registration for your tenant only, through `az`, when you are signed in with it.
   - **Okta**: a web OIDC app assigned to Everyone, from your Okta URL (https) and an admin API token. Later runs reuse the app with a new client secret; once it holds the two secrets Okta allows, setup asks you to delete an unused one first.
   - **Google** and others: guided, with the redirect URI to paste.

Secrets you type are hidden. A saved secret is never shown again; an empty answer keeps it.

## After setup

Setup pulls the images of its version, starts Spyria with a runtime host on this machine and prints the **setup link**.

1. Open it and create the first workspace by signing in.
2. The machine's runtime host is already in **Workspace settings**.
3. Open **GitHub** there to work on repositories.

## Unattended install

Every question is also a flag (`spyria --help`). Secrets are read from environment variables instead, to keep them out of shell history and the process list; setup says when it uses one, never its value:

- `SPYRIA_SETUP_CLOUDFLARE_TOKEN`
- `SPYRIA_SETUP_GOOGLE_CLIENT_SECRET`
- `SPYRIA_SETUP_MICROSOFT_CLIENT_SECRET`
- `SPYRIA_SETUP_OIDC_CLIENT_SECRET`
- `SPYRIA_SETUP_OKTA_TOKEN`
- `SPYRIA_SETUP_HOST_CLAIM_URL`

```sh
printf 'Cloudflare API token: '; stty -echo; read -r SPYRIA_SETUP_CLOUDFLARE_TOKEN; stty echo; echo
printf 'Google client secret: '; stty -echo; read -r SPYRIA_SETUP_GOOGLE_CLIENT_SECRET; stty echo; echo
export SPYRIA_SETUP_CLOUDFLARE_TOKEN SPYRIA_SETUP_GOOGLE_CLIENT_SECRET
spyria setup --unattended --hostname spyria.example.com --google-client-id <client id>
```

## Running setup again

`spyria setup` keeps every secret, the tunnel, the HTTPS choice and the answers you do not change.

- It checks every answer before creating anything in Cloudflare, Microsoft Entra or Okta.
- It saves each secret to `.env` as soon as it gets it and prints a first workspace's client secret as soon as it is created, so a run that stops halfway loses neither; the next run goes on from there. The rest of `.env`, the version included, changes only at the end.
- It rewrites `.env` in place (as does `spyria upgrade`), keeping your comments, `export` prefixes and own variables.
- Without `.env`, it refuses to start over a deployment whose data is still on the machine ([troubleshooting](./troubleshooting.md)).
- Other commands use the current folder only when its `compose.yml` and `.env` are Spyria's.

### Tunnel or direct HTTPS

- `--https direct` on a tunnel install stops `cloudflared` and removes its token from `.env`. The tunnel and its DNS record stay in Cloudflare: replace the CNAME record with an A or AAAA record to the machine, and delete the tunnel in **Zero Trust > Networks > Tunnels**.
- `--https tunnel` on a direct install stops Caddy and asks for a Cloudflare token. Its certificates stay in the `<deployment>-caddy-data` volume.

### Runtime host on or off

- `--no-host` installs without a runtime host on this machine, and later runs keep it off.
  - If the machine already runs one, setup removes it and stops its runtimes, keeping their files. Also remove it in **Workspace settings > Runtimes** to revoke its token; [removing a host](../features/machines.md#removing-a-host) deletes its runtimes and files.
- `--host` turns it back on.
  - Before the first workspace exists, the host joins it when you create it.
  - Once one exists, setup asks for the command from **Workspace settings > Runtimes > Add runtime host** (or reads `SPYRIA_SETUP_HOST_CLAIM_URL`). Only this Spyria's **Add runtime host** command works, not the one for a member's own machine.
  - Setup asks Spyria whether a workspace exists, so Spyria must be running; unattended, it stops if Spyria does not answer, unless `SPYRIA_SETUP_HOST_CLAIM_URL` is set.
  - Turning the host back on, or giving another **Add runtime host** command, removes the host container and its old pairing, so the host pairs with the new code.

## Good to know

- On a laptop, Spyria is unreachable while the machine sleeps and running agent turns are interrupted. Docker and Compose's restart policies bring everything back on wake or restart.
- `spyria doctor` checks Docker, each service, the server's start check, the disk, the versions, the mode of `.env`, its credentials and the published ports. With direct HTTPS, it also checks Caddy and warns when its certificate expires in under 14 days.
- With direct HTTPS, setup waits for `https://<hostname>/health`. If Caddy gets no certificate, setup prints its last certificate error: usually the hostname does not point at the machine, or ports 80 and 443 are closed by a firewall or the provider.
- The certificates are not in the backups: Caddy gets new ones.
- Upgrades and backups: [operations](./operations.md).
- Managed clouds: [Install on AWS, Azure or Google Cloud](./cloud.md).
- By hand, or to see what the tool does: [manual install](./self-hosting.md).
- When something goes wrong: [troubleshooting](./troubleshooting.md).

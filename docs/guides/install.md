# Install on one machine

## What you need

- A Linux machine or a Mac.
- Docker. On Linux the script offers to install Docker Engine with Docker's own script; on a Mac, use Docker Desktop or OrbStack.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | sh
```

## What setup asks

1. **Deployment name and install folder.**
   - The deployment name, `spyria` by default, starts the name of every Docker container and volume of the install, so two installs on one machine stay apart.
   - The install folder, `~/spyria` by default, holds the configuration, its secrets and the backups.
2. **Hostname**, such as `spyria.example.com`.
3. **How people reach Spyria**:
   - `tunnel` (the default): through a Cloudflare tunnel, with no open port, for a laptop or a machine that cannot open ports. The hostname must be on a domain of your Cloudflare account.
   - `direct`: without a tunnel. The machine must serve ports 80 and 443 and be reachable from the internet (behind a VPC or NAT, forward these ports to it: see [direct HTTPS behind a VPC or NAT](#direct-https-behind-a-vpc-or-nat)).
   - With `direct`, setup checks, and stops before writing anything if one fails:
     - that the hostname has an A or AAAA record;
     - on rootless Docker, that ports below 1024 are allowed (`sudo sysctl net.ipv4.ip_unprivileged_port_start=80`);
     - that ports 80 and 443 are free on the machine.
4. **Cloudflare API token** (tunnel only), with the permissions setup names when it asks.
   - The tool creates a tunnel to the server and its DNS record; no port opens on the machine.
   - A hostname with other DNS records (an A or AAAA record of a website, say) is refused: delete them or choose another.
5. **Account providers** (each optional). People sign in to Spyria with these accounts, create workspaces and join the ones they are invited to ([who can join and sign-in](./who-can-join.md)).
   - **Google**: an OAuth client (any Google account, Gmail included).
   - **Microsoft**: an app for any organizational directory and personal accounts. Answer `create` to register it with `az`; later runs reuse it.
   - **OIDC provider**: issuer URL, client id and secret.
   - With none, people sign in only through the first workspace's own provider, and nobody can create more workspaces.

## After setup

Setup starts Spyria with a runtime host on the machine and prints the **setup link**. Open it and create the first workspace by signing in.

## Unattended install

Every question is also a flag (`spyria --help`); a flag setup does not know is refused. The list of accessible flags is:

| Flag | Answer |
|---|---|
| `--unattended` | Asks no question: every answer comes from a flag or its default. |
| `--folder <path>` | Install folder (default `~/spyria`). |
| `--name <name>` | Deployment name (default `spyria`). |
| `--hostname <hostname>` | Hostname, such as `spyria.example.com`. |
| `--https tunnel\|direct` | How people reach Spyria (default `tunnel`). |
| `--google-client-id <id>` | Google account provider. |
| `--microsoft-client-id <id>\|create` | Microsoft account provider; `create` registers it with `az`. |
| `--oidc-issuer <url>`, `--oidc-client-id <id>` | OIDC account provider. |
| `--version <version>` | Release to run (default: the tool's own). |
| `--images <registry>` | Registry of your own build of the images, for a fork (default: Spyria's published images). |
| `--port <port>` | Local port of the server (default `3300`). |
| `--no-host` | No runtime host on this machine. |
| `--host` | Turns the runtime host back on. |
| `--no-start` | Writes the folder without starting Spyria. |

Secrets are never flags, so they stay out of your shell history. Setup reads them from these environment variables:

- `SPYRIA_SETUP_CLOUDFLARE_TOKEN`
- `SPYRIA_SETUP_GOOGLE_CLIENT_SECRET`
- `SPYRIA_SETUP_MICROSOFT_CLIENT_SECRET`
- `SPYRIA_SETUP_OIDC_CLIENT_SECRET`
- `SPYRIA_SETUP_HOST_CLAIM_URL`

```sh
printf 'Cloudflare API token: '; stty -echo; read -r SPYRIA_SETUP_CLOUDFLARE_TOKEN; stty echo; echo
printf 'Google client secret: '; stty -echo; read -r SPYRIA_SETUP_GOOGLE_CLIENT_SECRET; stty echo; echo
export SPYRIA_SETUP_CLOUDFLARE_TOKEN SPYRIA_SETUP_GOOGLE_CLIENT_SECRET
spyria setup --unattended --hostname spyria.example.com --google-client-id <client id>
```

## Upgrade

```sh
spyria upgrade            # the latest release, or: spyria upgrade 1.3.0
```

It backs up both databases into `backups/`, fetches the release's Compose file and gateway configuration, pulls and starts the new images, waits for `/health`, and prints the link to what changed.

- Migrations run before the server starts. A failed one leaves the old server down; the reason is in `spyria compose logs migrate`.
- Runtimes move to the new runtime image the next time they start; running ones keep theirs until they stop.
- Runtime hosts on other machines show **Update available** in Workspace settings (or on the member's profile), or **Update needed** when the host is refused until updated. Either badge opens the command that updates it in place.

## Good to know

- On a laptop, Spyria is unreachable while the machine sleeps and running agent turns are interrupted. Docker and Compose's restart policies bring everything back on wake or restart.
- With direct HTTPS, setup waits for `https://<hostname>/health`. If no certificate is issued, setup prints the last certificate error: usually the hostname does not point at the machine, or ports 80 and 443 are closed by a firewall or the provider.

### Direct HTTPS behind a VPC or NAT

The machine itself needs no public IP: you only need to reach ports 80 and 443 at the hostname's address.

- **What works:** a cloud VM in a private subnet with a public or elastic IP; a NAT gateway, firewall or home router forwarding TCP 80 and 443 to the machine; a load balancer passing TCP through without serving HTTPS itself.
- **What does not work:**
  - a private-only network (reached over a VPN, no inbound internet), or a hostname pointing at a private address (`10.x`, `192.168.x`): no certificate can be issued. Use the tunnel, or the [manual install](./self-hosting.md) with your own certificate;
  - a load balancer that serves HTTPS with its own certificate: Spyria must then run behind it without serving HTTPS itself, which is the [manual install](./self-hosting.md).

# Install on one machine

On a Linux machine, a Mac or a PC under WSL, with a domain on Cloudflare:

```sh
curl -fsSL https://spyria.dev/install | sh
```

or, the same script straight from the latest release: `curl -fsSL https://github.com/Camil-H/spyria/releases/latest/download/install.sh | sh`.

The script checks Docker (on Linux it offers to install Docker Engine with Docker's own script; on a Mac it points to Docker Desktop or OrbStack), downloads the `spyria` tool for the machine, checks it against the release's checksums, installs it in `~/.local/bin`, then runs `spyria setup`, which asks:

1. **The deployment name and the install folder** (`spyria` and `~/spyria`). The folder holds `compose.yml`, `bifrost.json`, `.env` (readable by you only, with every secret generated) and `backups/`.
2. **The hostname** of Spyria, for example `spyria.example.com`, on a domain of your Cloudflare account, and a **Cloudflare API token** with *Account > Cloudflare Tunnel > Edit*, *Zone > DNS > Edit* and *Zone > Zone > Read* (Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token). The tool creates a tunnel routing the hostname to the server, with its DNS record; no port opens on the machine. The token is used for this and never stored.
3. **Who can join**: people at your email domain (each workspace owns a verified domain), or only the addresses you invite (any Google or OIDC account, Gmail included; see [admin](../features/admin.md#who-can-join)).
4. **Sign-in apps of this Spyria** (optional): a Google OAuth client, and on a by-domain instance a Microsoft Entra app (answer `create` to register it with `az`, signed in as an admin of your directory), so workspaces sign in without registering their own; it shows where to create them and the redirect URI to paste.
5. **The provider of the first workspace**, set up for you where it has an API and you are an admin there; the tool then prints what to enter in **Create a workspace** (the client secret only this once):
   - **Cloudflare Access** (by email domain; set up Zero Trust once in the Cloudflare dashboard first, which picks your team domain): an Access application signing in people at your domain with a one-time PIN. You create the workspace signing in as `admin@<domain>`: when the domain receives no mail yet, Email Routing forwards that address to your own (Cloudflare first emails you a confirmation to open), so the PIN and the verification link reach you; when it already has mailboxes, the tool leaves its mail alone and `admin@<domain>` must be one you read. The API token then also needs *Account > Access: Apps and Policies > Edit*, *Account > Access: Organizations, Identity Providers, and Groups > Edit*, *Account > Email Routing Addresses > Edit* and *Zone > Email Routing Rules > Edit*.
   - **Microsoft Entra**: a tenant-only app registration through `az`, when you are signed in with it.
   - **Okta**: a web OIDC app assigned to Everyone, from your Okta URL and an admin API token.
   - **Google** and any other provider: guided, with the redirect URI to paste.
6. **Mail** (optional): an SMTP URL and sender, or **Resend**: from a Resend API key, the tool adds your domain to Resend, writes the DNS records Resend lists into your Cloudflare zone, waits until Resend verifies them, and stores a sending-only key. It sends a test message if you give an address. Without mail, `spyria verify-domain` verifies a domain.

It then pulls the images of its version, starts Spyria with a runtime host on this machine, waits until it answers, and prints the **setup link** that creates the first workspace. Open it, create the workspace through your provider, and the machine's runtime host is already in **Workspace settings**; then **Connect GitHub** there to work on repositories.

Every question is also a flag, for an unattended install, except secrets: those come from environment variables (`CLOUDFLARE_API_TOKEN`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `OKTA_API_TOKEN`, `RESEND_API_KEY`, `SPYRIA_SMTP_URL`), so they stay out of your shell history and process list. For example:

```sh
read -rsp 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
spyria setup --unattended --hostname spyria.example.com --join-by invited-address
```

`spyria --help` lists the flags. A saved secret is never shown again: an empty answer keeps it. Running `spyria setup` again keeps every secret, the tunnel and the answers you do not change. `--no-host` installs without a runtime host on this machine and stays so on later runs, until `--host` turns it back on.

On a laptop or a personal computer: while it sleeps Spyria is unreachable, and running agent turns are interrupted; Docker and Compose's restart policies bring everything back when it wakes or restarts. `spyria doctor` checks Docker, each service, the server's start check, the disk and the versions; upgrades and backups are in [operations](./operations.md).

To run on managed services of AWS, Azure or Google Cloud instead, see [Install on AWS, Azure or Google Cloud](./cloud.md). To install by hand, or to see what the tool does underneath, see the [manual install](./self-hosting.md); when something goes wrong, [troubleshooting](./troubleshooting.md).


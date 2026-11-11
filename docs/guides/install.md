# Install on one machine

On a Linux machine, a Mac or a PC under WSL, with a domain on Cloudflare:

```sh
curl -fsSL https://spyria.dev/install | sh
```

or, the same script straight from the latest release: `curl -fsSL https://github.com/Camil-H/spyria/releases/latest/download/install.sh | sh`.

The script checks Docker (on Linux it offers to install Docker Engine with Docker's own script; on a Mac it points to Docker Desktop or OrbStack), downloads the `spyria` tool for the machine, checks it against the release's checksums and, when [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) is installed, that the Publish workflow of the repository signed those checksums (`SPYRIA_REQUIRE_SIGNATURE=1` refuses to install without cosign), installs it in `~/.local/bin`, then runs `spyria setup`, which asks:

1. **The deployment name and the install folder** (`spyria` and `~/spyria`). The folder holds `compose.yml`, `bifrost.json`, `.env` (readable by you only, with every secret generated) and `backups/`. Setup refuses a folder whose `compose.yml` or `.env` belongs to another project, and the other commands take the current folder for the install only when those files are Spyria's. Setup and `spyria upgrade` rewrite `.env` in place, keeping your comments, `export` prefixes and own variables.
2. **The hostname** of Spyria, for example `spyria.example.com`, on a domain of your Cloudflare account, and a **Cloudflare API token** with *Account > Cloudflare Tunnel > Edit*, *Zone > DNS > Edit* and *Zone > Zone > Read* (Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token). The tool creates a tunnel routing the hostname to the server, with its DNS record; no port opens on the machine. A hostname that already has other DNS records (an A or AAAA record of a website, say) is refused: delete them in Cloudflare or choose another hostname. The token is used for this and never stored.
3. **Who can join**: people at your email domain (each workspace owns a verified domain), or only the addresses you invite (any Google or OIDC account, Gmail included; see [admin](../features/admin.md#who-can-join)).
4. **Sign-in apps of this Spyria** (optional): a Google OAuth client, and on a by-domain instance a Microsoft Entra app (answer `create` to register it with `az`, signed in as an admin of your directory; running setup again reuses the app it registered), so workspaces sign in without registering their own; it shows where to create them and the redirect URI to paste.
5. **The provider of the first workspace**, set up for you where it has an API and you are an admin there; the tool then prints what to enter in **Create a workspace** (the client secret only this once):
   - **Cloudflare Access** (by email domain; set up Zero Trust once in the Cloudflare dashboard first, which picks your team domain): an Access application signing in people at your domain with a one-time PIN. You create the workspace signing in as `admin@<domain>`: when the domain receives no mail yet, Email Routing forwards that address to your own (Cloudflare first emails you a confirmation to open), so the PIN and the verification link reach you; when it already has mailboxes, the tool leaves its mail alone and `admin@<domain>` must be one you read. The API token then also needs *Account > Access: Apps and Policies > Edit*, *Account > Access: Organizations, Identity Providers, and Groups > Edit*, *Account > Email Routing Addresses > Edit* and *Zone > Email Routing Rules > Edit*.
   - **Microsoft Entra**: a tenant-only app registration through `az`, when you are signed in with it.
   - **Okta**: a web OIDC app assigned to Everyone, from your Okta URL (https) and an admin API token.
   - **Google** and any other provider: guided, with the redirect URI to paste.
6. **Mail** (optional): an SMTP URL and sender, or **Resend**: from a Resend API key, the tool adds your domain to Resend, writes the DNS records Resend lists into your Cloudflare zone, waits until Resend verifies them, and stores a sending-only key. Setting up Resend again deletes the key it replaces once Spyria runs on the new one; with `--no-start`, setup says the earlier key stays valid until you delete it in Resend. It sends a test message if you give an address. Without mail, `spyria verify-domain` verifies a domain.

It then pulls the images of its version, starts Spyria with a runtime host on this machine, waits until it answers, and prints the **setup link** that creates the first workspace. Open it, create the workspace through your provider, and the machine's runtime host is already in **Workspace settings**; then **Connect GitHub** there to work on repositories.

Every question is also a flag, for an unattended install, except secrets: those come from environment variables (`SPYRIA_SETUP_CLOUDFLARE_TOKEN`, `SPYRIA_SETUP_GOOGLE_CLIENT_SECRET`, `SPYRIA_SETUP_MICROSOFT_CLIENT_SECRET`, `SPYRIA_SETUP_OKTA_TOKEN`, `SPYRIA_SETUP_RESEND_KEY`, `SPYRIA_SETUP_SMTP_URL`, `SPYRIA_SETUP_HOST_CLAIM_URL`), so they stay out of your shell history and process list. Setup says when it takes one from the environment, never its value. For example:

```sh
printf 'Cloudflare API token: '; stty -echo; read -r SPYRIA_SETUP_CLOUDFLARE_TOKEN; stty echo; echo
export SPYRIA_SETUP_CLOUDFLARE_TOKEN
spyria setup --unattended --hostname spyria.example.com --join-by invited-address
```

`spyria --help` lists the flags. A secret you type does not show on the screen, and a saved one is never shown again: an empty answer keeps it. Running `spyria setup` again keeps every secret, the tunnel and the answers you do not change. `--no-host` installs without a runtime host on this machine and stays so on later runs, until `--host` turns it back on. When this machine already runs a host, setup removes it and stops its runtimes, keeping their files; remove the host in **Workspace settings > Connect runtime** too, which revokes its token, and see [removing a host](../features/machines.md#removing-a-host) to delete its runtimes and their files. With `--host`, before the first workspace exists, the host joins it when you create it; once one exists, setup asks for the command an admin gets from **Workspace settings > Connect runtime > Add runtime host** (or reads it from `SPYRIA_SETUP_HOST_CLAIM_URL`), and the host joins that workspace. Setup asks Spyria whether a workspace exists, so it needs Spyria running then; unattended, it stops when Spyria does not answer, unless that variable is set. Only the command of **Add runtime host** for this Spyria serves, not the one of a member's own machine. When setup turns the host back on, or takes another command of **Add runtime host**, it removes the host container and the pairing this machine kept, so the host pairs with the new code.

On a laptop or a personal computer: while it sleeps Spyria is unreachable, and running agent turns are interrupted; Docker and Compose's restart policies bring everything back when it wakes or restarts. `spyria doctor` checks Docker, each service, the server's start check, the disk and the versions; upgrades and backups are in [operations](./operations.md).

To run on managed services of AWS, Azure or Google Cloud instead, see [Install on AWS, Azure or Google Cloud](./cloud.md). To install by hand, or to see what the tool does underneath, see the [manual install](./self-hosting.md); when something goes wrong, [troubleshooting](./troubleshooting.md).


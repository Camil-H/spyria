# Install on Google Cloud

## What you need

- [OpenTofu](https://opentofu.org/docs/intro/install/).
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install). Setup signs you in with `gcloud auth application-default login` when you are not.
- Owner on the project, since the module enables APIs and grants a service account access to its secrets.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | SPYRIA_SKIP_SETUP=1 sh
spyria setup --cloud gcp
```

Setup asks for:

1. The hostname, such as `spyria.example.com`, and the size: `small`, `medium` or `large` (about 6, 14 or 30 runtimes at once).
2. The project id and the region (default `europe-west1`).
3. The Cloud DNS managed zone of the hostname, or nothing when the DNS is elsewhere.

It writes `~/spyria-gcp/main.tf` and `terraform.tfvars` (readable by you only), runs `tofu init` and `tofu apply`, then prints the DNS records to create, if any, and the setup link.

Every question is also a flag (`spyria --help`): `--hostname`, `--size`, `--project`, `--region`, `--dns-zone`, `--version` and `--folder`. `--no-start` writes the folder without applying; `--unattended` asks no question and applies without confirmation.

The folder also holds the OpenTofu state, which contains the deployment's passwords and keys: keep it private and backed up. To keep the state elsewhere, such as in an encrypted Cloud Storage bucket, declare that backend in a file of its own like `backend.tf`, since setup rewrites `main.tf` on every run.

## After setup

1. Create the printed DNS records, if any.
2. Open the setup link and create the first workspace.

## Upgrades

- `spyria setup --cloud gcp --version <new version>` upgrades the control plane and keeps every other answer.
- Running `spyria setup --cloud gcp` again uses the folder's `terraform.tfvars` as defaults (`-` removes an optional answer) and applies the changes, keeping your own variables there.

### Updating runtime host VMs

Upgrades never replace runtime host VMs; they keep their pairing and runtimes. They show **Update available** in Workspace settings, with the command that updates them in place. The hosts have no public address: open a shell with the `runtime_host_access_command` setup prints (`gcloud compute ssh --tunnel-through-iap`, with OS Login; your account needs IAP-secured Tunnel User and Compute OS Admin Login), run `sudo -i`, then paste the command.

## What it runs

- **Server:** Cloud Run, one always-allocated instance with session affinity. It has no run.app address, so only the load balancer reaches it. Migrations run before the server in its container.
- **Images:** pulled through an Artifact Registry mirror of ghcr.io, which Cloud Run cannot pull from.
- **HTTPS:** a global HTTPS load balancer with a managed certificate.
- **zero-cache and gateway:** containers beside the server in its Cloud Run service, reached on localhost only, since Cloud Run counts any VM of the project, runtime hosts included, as internal.
- **Postgres:** Cloud SQL Postgres 18, private address only.
- **Secrets:** Secret Manager.
- **Runtime host:** a Compute Engine VM without a public address, reaching the internet through Cloud NAT. Its runtimes cannot reach the metadata endpoint or private ranges.
- **zero-cache replica:** an in-memory volume of 2, 5 and 8 GiB by size; its first sync may take up to 10 minutes, Cloud Run's maximum.

## Good to know

- **Size for the zero-cache replica.** zero-cache keeps its SQLite replica on the container's local storage (SQLite's write-ahead log does not work on network file systems) and rebuilds it from Postgres on start. It answers only after that first sync. Check that the replica's room and first sync under [What it runs](#what-it-runs) fit the database with room to grow.
- **zero-cache waits for the migrations** to create its publication and let its role replicate: it waits for the server and the gateway's configuration beside it.
- **Health checks:** the platform uses `GET /health/live` (the process and its database), not `/health`, which also fails while zero-cache rebuilds or the gateway restarts ([operations](./operations.md#health)).
- **Client addresses:** `SPYRIA_TRUSTED_PROXY=x-forwarded-for:2` makes rate limits key on the client's address, not the load balancer's.

## Without the spyria tool

The configuration uses two modules in [`deploy/tofu/modules/gcp`](../../deploy/tofu/modules/gcp):

- `control-plane`: the server, zero-cache, the model gateway and a managed Postgres, behind Google Cloud's HTTPS. It needs no Docker; runtimes never run on it.
- `runtime-host`: a VM running `spyria-host`, which dials out to the control plane.

1. Copy [`deploy/tofu/examples/gcp`](../../deploy/tofu/examples/gcp).
2. Replace each `source = "../../modules/…"` with `github.com/Camil-H/spyria//deploy/tofu/modules/…?ref=v<version>`.
3. Set the variables. The example declares every input below except `images` and the Google and Microsoft account providers, which you add to the `control_plane` module block. Apply this configuration with `tofu` from then on: `spyria setup --cloud` rewrites `main.tf` and would drop them.
4. Run `tofu init` and `tofu apply`; `tofu output -raw setup_link` prints the setup link.

Each service carries a digest of its secrets, so applying a changed secret restarts the services in the same apply.

| Input | Meaning |
|---|---|
| `hostname` | Public hostname of Spyria. |
| `spyria_version`, `images` | Release of the published images, and the registry of a fork's own images. |
| `google_client_id` and `_secret`, `microsoft_client_id` and `_secret` | Optional account providers: a Google OAuth client and a Microsoft app for any organization and personal accounts, with the redirect URI `https://<hostname>/auth/callback` ([who can join](./who-can-join.md)). |
| `oidc_issuer`, `oidc_client_id`, `oidc_client_secret` | Optional account provider of any other OIDC provider, all three or none. |
| `size` | `small`, `medium` or `large`: CPU and memory of the server and zero-cache, and the database's class; for a runtime host, about 6, 14 or 30 runtimes at once. Changing it restarts the runtime host VMs, stopping their running runtimes until the next prompt. |

| Output | Meaning |
|---|---|
| `origin_url` | Where Spyria answers. |
| `setup_link` | Creates the first workspace, once (sensitive). |
| `install_host_claim_url` | Pairs a runtime host with the first workspace, once (sensitive). Further hosts, each with its own `host_name`, take the claim URL of **Add runtime host**. |
| `dns_records` | The records to create when the module does not manage the DNS zone. |

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
- **zero-cache replica:** an in-memory volume of 2, 5 and 8 GiB by size; its first sync may take up to 10 minutes, Cloud Run's maximum ([sizing](./cloud.md#good-to-know)).

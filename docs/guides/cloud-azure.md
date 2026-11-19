# Install on Azure

## What you need

- [OpenTofu](https://opentofu.org/docs/intro/install/).
- The [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli). Setup signs you in with `az login` when you are not.
- Owner, or Contributor with User Access Administrator, on the subscription, since the module grants Key Vault roles.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | SPYRIA_SKIP_SETUP=1 sh
spyria setup --cloud azure
```

Setup asks for:

1. The hostname, such as `spyria.example.com`, and the size: `small`, `medium` or `large` (about 6, 14 or 30 runtimes at once).
2. The subscription id and the region (default `westeurope`).
3. The Azure DNS zone of the hostname and its resource group, or nothing when the DNS is elsewhere.

It writes `~/spyria-azure/main.tf` and `terraform.tfvars` (readable by you only), runs `tofu init` and `tofu apply`, then prints the DNS records to create, if any, the certificate command and the setup link.

Every question is also a flag (`spyria --help`): `--hostname`, `--size`, `--subscription`, `--region`, `--dns-zone`, `--dns-zone-resource-group`, `--bind-hostname yes|no`, `--version` and `--folder`. `--no-start` writes the folder without applying; `--unattended` asks no question and applies without confirmation.

The folder also holds the OpenTofu state, which contains the deployment's passwords and keys: keep it private and backed up. To keep the state elsewhere, such as in an encrypted storage account, declare that backend in a file of its own like `backend.tf`, since setup rewrites `main.tf` on every run.

## After setup

1. Create the printed DNS records, if any. With the DNS outside Azure, run `spyria setup --cloud azure --bind-hostname yes` once they exist.
2. Run the printed `certificate_command`: the provider cannot bind a managed certificate, so this `az containerapp hostname bind` command creates and binds it.
3. Open the setup link and create the first workspace.

## Upgrades

- `spyria setup --cloud azure --version <new version>` upgrades the control plane and keeps every other answer.
- Running `spyria setup --cloud azure` again uses the folder's `terraform.tfvars` as defaults (`-` removes an optional answer) and applies the changes, keeping your own variables there.

### Updating runtime host VMs

Upgrades never replace runtime host VMs; they keep their pairing and runtimes. They show **Update available** in Workspace settings, with the command that updates them in place. The hosts accept no inbound traffic: save the command as `update.sh` in the current folder and run the `runtime_host_access_command` setup prints (`az vm run-command invoke … --scripts @update.sh`), which runs it as root.

### Who can apply

- Planning reads the Key Vault's secrets, so only accounts granted them can apply. With `secret_admin_object_ids` empty, the account applying is granted.
- To let others apply (another admin, a CI service principal), list every applying account's object id, yours included, on one line in `terraform.tfvars`, such as `secret_admin_object_ids = ["<yours>", "<ci>"]`, and apply once from an account that already can.
- An unlisted account is refused before anything changes, so no apply takes access from another.
- The module waits two minutes for each Key Vault grant to take effect.

## What it runs

- **Server:** Container Apps, one replica, migrations in an init container.
- **HTTPS:** the app's ingress with a managed certificate.
- **zero-cache and gateway:** apps with internal ingress.
- **Postgres:** Flexible Server 18 in a delegated subnet, with a lock against deletion outside OpenTofu.
- **Secrets:** Key Vault, read by a managed identity.
- **Runtime host:** a Linux VM with no inbound rule. Its runtimes cannot reach the metadata endpoint, the WireServer (`168.63.129.16`) or private ranges.
- **zero-cache replica:** ephemeral storage of 4 GiB at `small` and 8 GiB at `medium` and `large`; its first sync may take up to 30 minutes.

## Good to know

- **Size for the zero-cache replica.** zero-cache keeps its SQLite replica on the container's local storage (SQLite's write-ahead log does not work on network file systems) and rebuilds it from Postgres on start. It answers only after that first sync. Choose a size whose replica and first sync fit the database with room to grow.
- **zero-cache waits for the migrations** to create its publication and let its role replicate: a first container waits up to 10 minutes for both.
- **Health checks:** the platform uses `GET /health/live` (the process and its database), not `/health`, which also fails while zero-cache rebuilds or the gateway restarts ([operations](./operations.md#health)).
- **Client addresses:** `SPYRIA_TRUSTED_PROXY=x-forwarded-for:1` makes rate limits key on the client's address, not the load balancer's.

## Without the spyria tool

The configuration uses two modules in [`deploy/tofu/modules/azure`](../../deploy/tofu/modules/azure):

- `control-plane`: the server, zero-cache, the model gateway and a managed Postgres, behind Azure's HTTPS. It needs no Docker; runtimes never run on it.
- `runtime-host`: a VM running `spyria-host`, which dials out to the control plane.

1. Copy [`deploy/tofu/examples/azure`](../../deploy/tofu/examples/azure).
2. Replace each `source = "../../modules/…"` with `github.com/Camil-H/spyria//deploy/tofu/modules/azure/…?ref=v<version>`.
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

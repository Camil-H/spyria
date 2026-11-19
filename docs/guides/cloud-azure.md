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
- **zero-cache replica:** ephemeral storage of 4 GiB at `small` and 8 GiB at `medium` and `large`; its first sync may take up to 30 minutes ([sizing](./cloud.md#good-to-know)).

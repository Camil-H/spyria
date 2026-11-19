# Install on AWS

## What you need

- [OpenTofu](https://opentofu.org/docs/intro/install/).
- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), 2.32 or later. Setup signs you in with it when you are not: `aws sso login` when your profile uses IAM Identity Center, `aws login` otherwise.
- `AdministratorAccess`, or `PowerUserAccess` with `IAMFullAccess`, since the module creates IAM roles.
- A Route 53 zone for the hostname, or an issued ACM certificate for it in the chosen region.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | SPYRIA_SKIP_SETUP=1 sh
spyria setup --cloud aws
```

Setup asks for:

1. The hostname, such as `spyria.example.com`, and the size: `small`, `medium` or `large` (about 6, 14 or 30 runtimes at once).
2. The AWS region (default `eu-west-1`).
3. The Route 53 zone id of the hostname, or, without one, the ARN of an issued ACM certificate for it.

It writes `~/spyria-aws/main.tf` and `terraform.tfvars` (readable by you only), runs `tofu init` and `tofu apply`, then prints the DNS records to create, if any, and the setup link.

Every question is also a flag (`spyria --help`): `--hostname`, `--size`, `--region`, `--route53-zone-id`, `--certificate-arn`, `--version` and `--folder`. `--no-start` writes the folder without applying; `--unattended` asks no question and applies without confirmation.

The folder also holds the OpenTofu state, which contains the deployment's passwords and keys: keep it private and backed up. To keep the state elsewhere, such as in an encrypted S3 bucket, declare that backend in a file of its own like `backend.tf`, since setup rewrites `main.tf` on every run.

## After setup

1. Create the printed DNS records, if any.
2. Open the setup link and create the first workspace.

## Upgrades

- `spyria setup --cloud aws --version <new version>` upgrades the control plane and keeps every other answer.
- Running `spyria setup --cloud aws` again uses the folder's `terraform.tfvars` as defaults (`-` removes an optional answer) and applies the changes, keeping your own variables there.

### Updating runtime host VMs

Upgrades never replace runtime host VMs; they keep their pairing and runtimes. They show **Update available** in Workspace settings, with the command that updates them in place. The hosts accept no inbound traffic: open a shell with the `runtime_host_access_command` setup prints (`aws ssm start-session`, which needs the AWS CLI's Session Manager plugin), run `sudo -i`, then paste the command.

## What it runs

- **Server:** ECS Fargate, one task, migrations in an init container.
- **HTTPS:** an Application Load Balancer with an ACM certificate, and a 1-hour idle timeout.
- **zero-cache and gateway:** Fargate tasks reached through Cloud Map, never public.
- **Postgres:** RDS Postgres 18 in private subnets, with deletion protection.
- **Secrets:** Secrets Manager.
- **Runtime host:** an EC2 (Graviton) VM, IMDSv2 with a hop limit of 1. Its runtimes cannot reach the metadata endpoint or private ranges.
- **zero-cache replica:** 40 GiB at every size, with no limit on its first sync.

## Good to know

- **Size for the zero-cache replica.** zero-cache keeps its SQLite replica on the container's local storage (SQLite's write-ahead log does not work on network file systems) and rebuilds it from Postgres on start. It answers only after that first sync. Choose a size whose replica and first sync fit the database with room to grow.
- **zero-cache waits for the migrations** to create its publication and let its role replicate: a first container waits up to 10 minutes for both.
- **Health checks:** the platform uses `GET /health/live` (the process and its database), not `/health`, which also fails while zero-cache rebuilds or the gateway restarts ([operations](./operations.md#health)).
- **Client addresses:** `SPYRIA_TRUSTED_PROXY=x-forwarded-for:1` makes rate limits key on the client's address, not the load balancer's.

## Without the spyria tool

The configuration uses two modules in [`deploy/tofu/modules/aws`](../../deploy/tofu/modules/aws):

- `control-plane`: the server, zero-cache, the model gateway and a managed Postgres, behind AWS's HTTPS. It needs no Docker; runtimes never run on it.
- `runtime-host`: a VM running `spyria-host`, which dials out to the control plane.

1. Copy [`deploy/tofu/examples/aws`](../../deploy/tofu/examples/aws).
2. Replace each `source = "../../modules/…"` with `github.com/Camil-H/spyria//deploy/tofu/modules/aws/…?ref=v<version>`.
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

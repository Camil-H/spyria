# Install on AWS, Azure or Google Cloud

## What you need

- [OpenTofu](https://opentofu.org/docs/intro/install/).
- The cloud's command line, signed in: `aws sso login` or `aws configure`, `az login`, or `gcloud auth application-default login`. Setup checks it before applying.
- Rights to create the resources and grant roles to them:
  - **AWS**: `AdministratorAccess`, or `PowerUserAccess` with `IAMFullAccess`, since the module creates IAM roles.
  - **Azure**: Owner, or Contributor with User Access Administrator, on the subscription, since the module grants Key Vault roles.
  - **Google Cloud**: Owner on the project, since the module enables APIs and grants a service account access to its secrets.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | SPYRIA_SKIP_SETUP=1 sh
spyria setup --cloud aws      # or azure, gcp
```

1. Setup asks for the hostname, the size and the cloud's own settings.
2. It writes `~/spyria-<cloud>/main.tf` and `terraform.tfvars` (readable by you only).
3. It runs `tofu init` and `tofu apply`.
4. It prints the DNS records to create, if any, and the first workspace's setup link.

Every question is also a flag (`spyria --help`): `--hostname`, `--size small|medium|large`, `--region`, `--project` (Google Cloud), `--subscription` (Azure), `--dns-zone`, `--dns-zone-resource-group`, `--route53-zone-id`, `--certificate-arn`, `--bind-hostname yes|no`, `--version` and `--folder`. `--unattended` asks no question and applies without confirmation.

The folder also holds the OpenTofu state, which contains the deployment's passwords and keys: keep it private and backed up. To keep the state elsewhere, such as in an encrypted bucket, declare that backend in a file of its own like `backend.tf`, since setup rewrites `main.tf` on every run.

## After setup

1. Create the printed DNS records, if any.
2. On Azure, run the printed `certificate_command` ([good to know](#good-to-know)).
3. Open the setup link and create the first workspace.

## Upgrades

- Running `spyria setup --cloud <cloud>` again uses the folder's `terraform.tfvars` as defaults (`-` removes an optional answer) and applies the changes, keeping your own variables there.
- `spyria setup --cloud <cloud> --version <new version>` upgrades the control plane and keeps every other answer.

### Updating runtime host VMs

Upgrades and new OS images never replace runtime host VMs; they keep their pairing and runtimes. They show **Update available** in Workspace settings, with the command that updates them in place. The hosts accept no other inbound traffic, so run it through the `runtime_host_access_command` output, which setup prints:

- **AWS**: a Session Manager shell (`aws ssm start-session`, needs the AWS CLI's Session Manager plugin). Run `sudo -i`, then paste the command.
- **Google Cloud**: SSH through Identity-Aware Proxy with OS Login (`gcloud compute ssh --tunnel-through-iap`; your account needs IAP-secured Tunnel User and Compute OS Admin Login). Run `sudo -i`, then paste the command.
- **Azure**: save the command as `update.sh` in the current folder and run the output, `az vm run-command invoke … --scripts @update.sh`, which runs it as root.

### Who can apply on Azure

- The module waits two minutes for each Key Vault grant to take effect.
- Planning reads the Key Vault's secrets, so only accounts granted them can apply. With `secret_admin_object_ids` empty, the account applying is granted.
- To let others apply (another admin, a CI service principal), list every applying account's object id, yours included, on one line in `terraform.tfvars`, such as `secret_admin_object_ids = ["<yours>", "<ci>"]`, and apply once from an account that already can.
- An unlisted account is refused before anything changes, so no apply takes access from another.

## Without the spyria tool

The configuration uses two modules per cloud in [`deploy/tofu/modules`](../../deploy/tofu/modules), with the same inputs and outputs on every cloud apart from where things go (region, project, DNS zone):

- `control-plane`: the server, zero-cache, the model gateway and a managed Postgres, behind the cloud's HTTPS. It needs no Docker; runtimes never run on it.
- `runtime-host`: a VM running `spyria-host`, which dials out to the control plane.

1. Copy [`deploy/tofu/examples/<cloud>`](../../deploy/tofu/examples).
2. Replace each `source = "../../modules/…"` with `github.com/Camil-H/spyria//deploy/tofu/modules/…?ref=v<version>`.
3. Set the variables. The examples declare every input below except `images` and the Google and Microsoft account providers, which you add to the `control_plane` module block.
4. Run `tofu init` and `tofu apply`; `tofu output -raw setup_link` prints the setup link.

Each service carries a digest of its secrets, so applying a changed secret restarts the services in the same apply.

| Input | Meaning |
|---|---|
| `hostname` | Public hostname of Spyria. |
| `spyria_version`, `images` | Release of the published images, and their registry (default `ghcr.io/camil-h`). |
| `google_client_id` and `_secret`, `microsoft_client_id` and `_secret` | Optional account providers: a Google OAuth client and a Microsoft app for any organization and personal accounts, with the redirect URI `https://<hostname>/auth/callback` ([who can join](./who-can-join.md)). |
| `oidc_issuer`, `oidc_client_id`, `oidc_client_secret` | Optional account provider of any other OIDC provider, all three or none. |
| `size` | `small`, `medium` or `large`: CPU and memory of the server and zero-cache, and the database's class; for a runtime host, about 6, 14 or 30 runtimes at once. Changing it restarts the runtime host VMs, stopping their running runtimes until the next prompt. |

| Output | Meaning |
|---|---|
| `origin_url` | Where Spyria answers. |
| `setup_link` | Creates the first workspace, once (sensitive). |
| `install_host_claim_url` | Pairs a runtime host with the first workspace, once (sensitive). Further hosts, each with its own `host_name`, take the claim URL of **Add runtime host**. |
| `dns_records` | The records to create when the module does not manage the DNS zone. |

## What each cloud runs

| | AWS | Azure | Google Cloud |
|---|---|---|---|
| Server | ECS Fargate, one task, migrations in an init container | Container Apps, one replica, migrations in an init container | Cloud Run, one always-allocated instance with session affinity and no run.app address, so only the load balancer reaches it; migrations run before the server in its container; images pulled through an Artifact Registry mirror of ghcr.io, which Cloud Run cannot pull from |
| HTTPS | Application Load Balancer, ACM certificate (Route 53 zone, or an issued certificate), 1-hour idle timeout | The app's ingress with a managed certificate | Global HTTPS load balancer with a managed certificate |
| zero-cache, gateway | Fargate tasks reached through Cloud Map, never public | Apps with internal ingress | Containers beside the server in its Cloud Run service, reached on localhost only, since Cloud Run counts any VM of the project, runtime hosts included, as internal |
| Postgres | RDS Postgres 18, `rds.logical_replication = 1`, private subnets, deletion protection | Flexible Server 18, `wal_level = logical`, delegated subnet, delete lock against deletion outside OpenTofu | Cloud SQL Postgres 18, `cloudsql.logical_decoding = on`, private address only |
| Secrets | Secrets Manager | Key Vault, read by a managed identity | Secret Manager |
| Runtime host | EC2 (Graviton), IMDSv2 with a hop limit of 1 | Linux VM, no inbound rule | Compute Engine VM without a public address, through Cloud NAT |
| zero-cache replica storage | 40 GiB at every size | Ephemeral storage: 4 GiB at `small`, 8 GiB at `medium` and `large` | In-memory volume: 2, 5 and 8 GiB |
| Wait for zero-cache's first sync | No limit | Up to 30 minutes | Up to 10 minutes, Cloud Run's maximum |
| `SPYRIA_TRUSTED_PROXY` | `x-forwarded-for:1` | `x-forwarded-for:1` | `x-forwarded-for:2` |

Runtime host VMs install Docker and `spyria-host` with cloud-init, and drop their runtimes' traffic to the metadata endpoint and private ranges (DNS excepted), and on Azure to the WireServer (168.63.129.16), so an agent cannot read the VM's cloud credentials or reach internal services.

## Good to know

- **Size for the zero-cache replica.** zero-cache keeps its SQLite replica on the container's local storage (SQLite's write-ahead log does not work on network file systems such as EFS or Azure Files) and rebuilds it from Postgres on start. It answers only after that first sync. Choose a cloud and size whose replica and first sync fit the database with room to grow (limits in the table).
- **zero-cache waits for the migrations** to create its publication and let its role replicate. On Google Cloud it waits for the server and the gateway's configuration beside it; on AWS and Azure a first container waits up to 10 minutes for both.
- **Azure certificate:** the provider cannot bind a managed certificate. The module adds the hostname, and the `certificate_command` output (an `az containerapp hostname bind` command, printed by `spyria setup --cloud azure`) creates and binds it.
- **Azure with a DNS zone outside Azure:** apply once with `binds_hostname = false`, create the two `dns_records`, then apply again.
- **Health checks:** the platforms use `GET /health/live` (the process and its database), not `/health`, which also fails while zero-cache rebuilds or the gateway restarts ([operations](./operations.md#health)).
- **Client addresses:** `SPYRIA_TRUSTED_PROXY` (table) makes rate limits key on the client's address, not the load balancer's.
- **Release checks:** `bun run check:tofu` checks the modules (format, `validate`, `tofu test` with mock providers), in CI when they change. Before a release, a real apply per cloud by hand proves the managed services' details: Postgres 18 in the chosen region, logical replication with the managed admin role, the platform's WebSocket limits, and Cloudflare-independent HTTPS.

# Install on AWS, Azure or Google Cloud

Each cloud has two OpenTofu modules in [`deploy/tofu/modules`](../../deploy/tofu/modules): `control-plane` (the server, zero-cache, the model gateway and a managed Postgres, behind the cloud's HTTPS) and `runtime-host` (a VM running `spyria-host`). Their inputs and outputs are the same on every cloud, apart from where things go (region, project, DNS zone). Runtimes never run on the control plane: it needs no Docker; runtime hosts dial out to it.

## With the spyria tool

With [OpenTofu](https://opentofu.org/docs/intro/install/) and the cloud's command line signed in (`aws sso login` or `aws configure`, `az login`, `gcloud auth application-default login`):

```sh
spyria setup --cloud aws      # or azure, gcp
```

It asks for the hostname, who can join, the size and the cloud's own settings, writes `~/spyria-<cloud>/main.tf` (the example of its version, using the modules of the same release tag) and `terraform.tfvars` (readable by you only), runs `tofu init` and `tofu apply`, then prints the DNS records to create, if any, and the setup link of the first workspace. A runtime host VM is created next to the control plane and pairs with the first workspace when you create it, through the install code. The OpenTofu state, in that folder, holds every secret of the deployment: keep it private, or move it to a remote backend with encryption. Run from a folder holding Spyria on the same cloud, setup uses that folder; it refuses a folder holding Spyria on another cloud or any other OpenTofu configuration or state.

Running it again takes the answers in the folder's `terraform.tfvars` as the defaults (`-` removes an optional one; the saved SMTP URL is never shown) and applies the changes, keeping variables of your own in that file; `spyria setup --cloud <cloud> --version <new version>` upgrades the control plane and keeps every other answer. Runtime host VMs are never replaced by an upgrade or a new OS image: they keep their pairing and runtimes, and show **Update available** in Workspace settings with the command that updates them in place. On Azure, the account applying needs Owner or User Access Administrator on the subscription, since the module grants Key Vault roles; it waits two minutes for each grant to take effect.

## By hand

Copy [`deploy/tofu/examples/<cloud>`](../../deploy/tofu/examples), replace each `source = "../../modules/…"` with `github.com/Camil-H/spyria//deploy/tofu/modules/…?ref=v<version>`, set the variables, then `tofu init` and `tofu apply`. `tofu output -raw setup_link` prints the setup link.

| Input | Meaning |
|---|---|
| `hostname` | Public hostname of Spyria. |
| `spyria_version`, `images` | Release of the published images, and their registry (default `ghcr.io/camil-h`). |
| `join_by` | `domain` or `invited-address` ([who can join](../features/admin.md#who-can-join)). |
| `smtp_url`, `mail_from` | Optional mail. |
| `google_client_id` and `_secret`, `microsoft_client_id` and `_secret` | Optional sign-in apps of the instance. |
| `sign_in_app_client_id` and `_secret` | Optional, together, when people join by invited address: replaces the one sign-in app of every workspace when the server restarts. Every service carries a digest of its secrets, so applying a changed secret, this one or any other, restarts the services with it in the same apply. |
| `size` | `small`, `medium` or `large`: the server's CPU and memory and the database's class; for a runtime host, about 6, 14 or 30 runtimes at once. Changing it restarts the runtime host VMs, which stops their running runtimes until the next prompt. |

| Output | Meaning |
|---|---|
| `origin_url` | Where Spyria answers. |
| `setup_link` | Creates the first workspace, once (sensitive). |
| `install_host_claim_url` | Pairs a runtime host with the first workspace, once (sensitive); further hosts, each with its own `host_name`, take the claim URL of **Add runtime host**. |
| `dns_records` | The records to create when the module does not manage the DNS zone. |

## What each cloud runs

| | AWS | Azure | Google Cloud |
|---|---|---|---|
| Server | ECS Fargate, one task, migrations in an init container | Container Apps, one replica, migrations in an init container | Cloud Run, one always-allocated instance with session affinity; migrations run before the server in its container; images pulled through an Artifact Registry mirror of ghcr.io, since Cloud Run cannot pull from it |
| HTTPS | Application Load Balancer, ACM certificate (Route 53 zone, or an issued certificate), 1-hour idle timeout | The app's ingress with a managed certificate | Global HTTPS load balancer with a managed certificate |
| zero-cache, gateway | Fargate tasks reached through Cloud Map, never public | Apps with internal ingress | Cloud Run services with internal ingress |
| Postgres | RDS Postgres 18, `rds.logical_replication = 1`, in private subnets, with deletion protection | Flexible Server 18, `wal_level = logical`, in a delegated subnet, with a delete lock against deletion outside OpenTofu | Cloud SQL Postgres 18, `cloudsql.logical_decoding = on`, private address only |
| Secrets | Secrets Manager | Key Vault, read by a managed identity | Secret Manager |
| Runtime host | EC2 (Graviton) with IMDSv2 and a hop limit of 1 | Linux VM, no inbound rule | Compute Engine VM without a public address, through Cloud NAT |

Every runtime host VM installs Docker and `spyria-host` with cloud-init, and drops its runtimes' traffic to the metadata endpoint and private ranges (DNS excepted), and on Azure to the WireServer (168.63.129.16), so an agent cannot read the VM's cloud credentials or reach internal services.

zero-cache keeps its SQLite replica on the container's local storage and rebuilds it from Postgres when it starts: SQLite's write-ahead log does not work on network file systems (EFS, Azure Files). The first sync after a restart takes longer on a large database.

On Azure, the provider cannot bind a managed certificate: the module adds the hostname to the server, and the `certificate_command` output (an `az containerapp hostname bind` command, which `spyria setup --cloud azure` prints) creates and binds the certificate. When the DNS zone is outside Azure, apply once with `binds_hostname = false`, create the two records of `dns_records`, then apply again.

## Before a release

The modules are checked by `bun run check:tofu` (format, `validate` and `tofu test` with mock providers), in CI when they change. A real apply per cloud is done by hand before a release; it is what proves the managed services' details: Postgres 18 in the chosen region, logical replication with the managed admin role, the platform's WebSocket limits, and Cloudflare-independent HTTPS.

## Health and client addresses

The platforms judge the server by `GET /health/live` (the process and its database), not `/health`, which also fails while zero-cache rebuilds its replica or the gateway restarts; [operations](./operations.md#health) has both. Each module sets `SPYRIA_TRUSTED_PROXY=x-forwarded-for:<n>` for its load balancer (1 on AWS and Azure, 2 on Google Cloud), so rate limits key on the client's address rather than the balancer's.

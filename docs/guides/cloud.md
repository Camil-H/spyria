# Install on AWS, Azure or Google Cloud

`spyria setup --cloud` deploys Spyria on a cloud's managed services with OpenTofu: a managed Postgres, the server behind the cloud's HTTPS, and a runtime host VM for agents.

- [Install on AWS](./cloud-aws.md)
- [Install on Azure](./cloud-azure.md)
- [Install on Google Cloud](./cloud-gcp.md)

This page holds what the three share.

## Without the spyria tool

The configuration uses two modules per cloud in [`deploy/tofu/modules`](../../deploy/tofu/modules), with the same inputs and outputs on every cloud apart from where things go (region, project, DNS zone):

- `control-plane`: the server, zero-cache, the model gateway and a managed Postgres, behind the cloud's HTTPS. It needs no Docker; runtimes never run on it.
- `runtime-host`: a VM running `spyria-host`, which dials out to the control plane.

1. Copy [`deploy/tofu/examples/<cloud>`](../../deploy/tofu/examples).
2. Replace each `source = "../../modules/…"` with `github.com/Camil-H/spyria//deploy/tofu/modules/…?ref=v<version>`.
3. Set the variables. The examples declare every input below except `images` and the Google and Microsoft account providers, which you add to the `control_plane` module block. Apply this configuration with `tofu` from then on: `spyria setup --cloud` rewrites `main.tf` and would drop them.
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

## Good to know

- **Size for the zero-cache replica.** zero-cache keeps its SQLite replica on the container's local storage (SQLite's write-ahead log does not work on network file systems such as EFS or Azure Files) and rebuilds it from Postgres on start. It answers only after that first sync. Choose a cloud and size whose replica and first sync fit the database with room to grow (limits on each cloud's page).
- **zero-cache waits for the migrations** to create its publication and let its role replicate. On Google Cloud it waits for the server and the gateway's configuration beside it; on AWS and Azure a first container waits up to 10 minutes for both.
- **Health checks:** the platforms use `GET /health/live` (the process and its database), not `/health`, which also fails while zero-cache rebuilds or the gateway restarts ([operations](./operations.md#health)).
- **Client addresses:** `SPYRIA_TRUSTED_PROXY` (`x-forwarded-for:1` on AWS and Azure, `x-forwarded-for:2` on Google Cloud) makes rate limits key on the client's address, not the load balancer's.
- **Release checks:** `bun run check:tofu` checks the modules (format, `validate`, `tofu test` with mock providers), in CI when they change. Before a release, a real apply per cloud by hand proves the managed services' details: Postgres 18 in the chosen region, logical replication with the managed admin role, the platform's WebSocket limits, and Cloudflare-independent HTTPS.

# Security

Where Spyria's secrets live and how to replace them. Commands use `spyria compose` ([operations](./operations.md)). How sign-in, permissions and credentials work: [architecture › security](../architecture/security.md).

## Secrets in files

The server, its operator CLI, the Compose migrations and `spyria-host` read each secret from the environment, or from a file when `<NAME>_FILE` holds its path. Example: `SPYRIA_SECRETS_KEY_FILE=/run/secrets/spyria_secrets_key` instead of `SPYRIA_SECRETS_KEY=…`. This works with Docker secrets, Kubernetes secret volumes and vault agents.

- A trailing newline in the file is dropped.
- A secret given both ways (non-empty value and `_FILE` path) stops the process at start, naming the setting.
- So does a file that cannot be read.

| Process | Secrets it reads from a file |
|---|---|
| Server, operator CLI, migrations (Compose) | `DATABASE_URL`, `SPYRIA_TOKEN_SECRET`, `SPYRIA_SECRETS_KEY`, `SPYRIA_PREVIOUS_SECRETS_KEYS`, `SPYRIA_SETUP_TOKEN`, `SPYRIA_INSTALL_HOST_TOKEN`, `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `SPYRIA_OIDC_CLIENT_SECRET`, `SPYRIA_GATEWAY_ADMIN_PASSWORD`, `OTEL_EXPORTER_OTLP_HEADERS` |
| `spyria-host` | `SPYRIA_HOST_CLAIM_URL`, `OTEL_EXPORTER_OTLP_HEADERS`, `HTTPS_PROXY`, `HTTP_PROXY` |

The other Compose services are not Spyria's:
- Postgres reads `POSTGRES_PASSWORD_FILE` itself.
- zero-cache and the gateway read their secrets from the environment only. So `SPYRIA_POSTGRES_PASSWORD` and `SPYRIA_GATEWAY_ADMIN_PASSWORD` always stay in `.env`, and must match the values in the files.

An install made by `spyria setup` keeps its secrets in `.env`: `spyria compose` runs only the Compose file it installed. On an install made by hand, put the files in an override file and add it to the alias (`-f compose.prod.yml -f compose.secrets.yml`):

```yaml
services:
  server:
    environment:
      SPYRIA_SECRETS_KEY: ''
      SPYRIA_SECRETS_KEY_FILE: /run/secrets/spyria_secrets_key
    secrets: [spyria_secrets_key]
secrets:
  spyria_secrets_key:
    file: ./secrets/spyria_secrets_key
```

The empty `SPYRIA_SECRETS_KEY` counts as unset, so the value from `.env` does not conflict with the file.

## Rotation intervals

Rotate a secret at once when it may have leaked or someone who held it leaves. Write each new value in `.env` (`.env.prod` on an install made by hand), and also in its file when a service [reads it from a file](#secrets-in-files).

| Secret | Rotate | How |
|---|---|---|
| `SPYRIA_SECRETS_KEY` | Every 12 months | [Rotating the secrets key](#rotating-the-secrets-key). No downtime; runtimes move to the new key as they restart. |
| `SPYRIA_TOKEN_SECRET` | Every 12 months | Set a new value, restart the server. Members stay signed in (sessions are not signed with it; 15-minute session tokens are renewed from them). A sign-in, GitHub connection or GitHub App creation in progress starts over. |
| `SPYRIA_GOOGLE_CLIENT_SECRET`, `SPYRIA_MICROSOFT_CLIENT_SECRET`, `SPYRIA_OIDC_CLIENT_SECRET` | Every 12 months, and before the provider expires it (Microsoft Entra allows at most 24 months) | Add a second secret at the provider, set it ([account providers](./operations.md#account-providers)), restart the server, then delete the old one at the provider. |
| `SPYRIA_POSTGRES_PASSWORD`, `SPYRIA_GATEWAY_DB_PASSWORD` | Every 12 months | Steps below the table. |
| `SPYRIA_ZERO_ADMIN_PASSWORD` | Every 12 months | Set a new value, run `spyria compose up -d zero-cache`. |
| `SPYRIA_GATEWAY_ADMIN_PASSWORD` | Every 12 months | Write it in `.env` (and the file of `SPYRIA_GATEWAY_ADMIN_PASSWORD_FILE` if used), run `spyria compose up -d gateway server`, check `/health` does not list `gateway` as failing. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `CLOUDFLARE_TUNNEL_TOKEN` | Per the collector's or Cloudflare's policy | Issue a new token there, set it, restart the services that use it. |
| `SPYRIA_GATEWAY_ENCRYPTION_KEY` | Only after a leak | Changing it makes members' API keys in the gateway unreadable: wipe the gateway's database and have members enter their keys again. |
| `SPYRIA_GATEWAY_SETUP_TOKEN` | Only after a leak | Set a new value, run `spyria compose up -d gateway`, check `/health` does not list `gateway` as failing. |
| `SPYRIA_SETUP_TOKEN`, `SPYRIA_INSTALL_HOST_TOKEN`, `SPYRIA_HOST_CLAIM_URL` | Not needed | One-time: spent once the first workspace exists or the host is paired. |

To rotate `SPYRIA_POSTGRES_PASSWORD` or `SPYRIA_GATEWAY_DB_PASSWORD` (the Postgres role keeps the password it was created with):
1. Run `spyria compose exec postgres psql -U spyria`, then `\password spyria` (or `\password bifrost` for the gateway's). This keeps the new value out of shell history.
2. Write it in `.env`, and in the files of `DATABASE_URL_FILE` and `POSTGRES_PASSWORD_FILE` if used.
3. Run `spyria compose up -d`. It restarts the services that use it, Postgres included, for a few seconds.

Good to know:
- `spyria setup` generates long-lived secrets from 32 random bytes each; the intervals limit how long a copied value stays useful.
- The cloud modules generate secrets in the cloud's secret manager. They cannot rotate `SPYRIA_SECRETS_KEY` yet.

## Rotating the secrets key

`SPYRIA_SECRETS_KEY` seals stored secrets (SSO client secrets, GitHub App credentials, members' GitHub tokens) and derives the key the server uses to reach each runtime. To replace it:

1. In `.env` (`.env.prod` on an install made by hand):
   - Move the current `SPYRIA_SECRETS_KEY` into `SPYRIA_PREVIOUS_SECRETS_KEYS` (comma-separated after any key already there).
   - Set `SPYRIA_SECRETS_KEY` to a new value of at least 32 characters, for example from `openssl rand -hex 32`.

   When they are [read from files](#secrets-in-files), edit the files instead (the override blanks the `.env` values): append the current key to the file of `SPYRIA_PREVIOUS_SECRETS_KEYS_FILE` (create that file and setting if needed), and write the new key into the file of `SPYRIA_SECRETS_KEY_FILE`.
2. Run `spyria compose up -d server`. The server now seals with the new key and still opens what previous keys sealed; running runtimes keep answering.
3. Seal every stored secret again:

   ```sh
   spyria compose exec server bun apps/server/src/operator-cli.ts secrets:reseal
   ```

   It reports how many secrets it resealed and how many running runtimes still use a previous key. Run it again later until it reports none:
   - A runtime moves to the new key the next time it starts.
   - An idle runtime stops after an hour.
   - A runtime in constant use never goes idle: **Stop runtime** in its chat's runtime menu stops it, and the next prompt starts it on the new key.
4. Remove `SPYRIA_PREVIOUS_SECRETS_KEYS` (or `SPYRIA_PREVIOUS_SECRETS_KEYS_FILE` and its file) and run `spyria compose up -d server` again.

Good to know:
- Keep the previous key with the backups taken before step 3: their secrets are sealed with it.
- The cloud modules do not take a previous key yet, so a cloud deployment cannot rotate the key this way.


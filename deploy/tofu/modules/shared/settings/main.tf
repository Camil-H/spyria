terraform {
  required_version = ">= 1.8"
}

variable "name" { type = string }
variable "hostname" { type = string }
variable "spyria_version" { type = string }
variable "images" { type = string }
variable "join_by" { type = string }
variable "smtp_url" {
  type      = string
  sensitive = true
}
variable "mail_from" { type = string }
variable "google_client_id" { type = string }
variable "google_client_secret" {
  type      = string
  sensitive = true
}
variable "microsoft_client_id" { type = string }
variable "microsoft_client_secret" {
  type      = string
  sensitive = true
}
variable "sign_in_app_client_id" { type = string }
variable "sign_in_app_client_secret" {
  type      = string
  sensitive = true
}
variable "secrets" {
  type      = map(string)
  sensitive = true
}
variable "database" {
  description = "Where the managed Postgres answers, whether it requires TLS, and the statement that lets the admin role replicate where the cloud needs one"
  type = object({
    host              = string
    port              = number
    user              = string
    requires_tls      = bool
    replication_grant = string
    spyria_name       = string
    gateway_name      = string
  })
}
variable "server_url" {
  description = "How zero-cache reaches the server inside the cloud network"
  type        = string
}
variable "zero_url" {
  description = "How the server reaches zero-cache inside the cloud network"
  type        = string
}
variable "gateway_url" {
  description = "How the server reaches the gateway inside the cloud network"
  type        = string
}
variable "zero_replica_file" { type = string }
variable "trusted_proxy" {
  description = "How the server finds the client address behind the cloud's load balancer, for example x-forwarded-for:1"
  type        = string
}

locals {
  origin       = "https://${var.hostname}"
  tls_suffix   = var.database.requires_tls ? "?sslmode=require" : ""
  database_url = "postgres://${var.database.user}:${var.secrets.database_password}@${var.database.host}:${var.database.port}/${var.database.spyria_name}${local.tls_suffix}"
  gateway_store = {
    host           = var.database.host
    port           = tostring(var.database.port)
    user           = "bifrost"
    password       = "env.BIFROST_DB_PASSWORD"
    db_name        = var.database.gateway_name
    ssl_mode       = var.database.requires_tls ? "require" : "disable"
    max_open_conns = 10
    max_idle_conns = 2
  }
}

output "origin_url" { value = local.origin }

output "server_image" { value = "${var.images}/spyria-server:${var.spyria_version}" }

output "host_image" { value = "${var.images}/spyria-host:${var.spyria_version}" }

output "zero_image" { value = "rocicorp/zero:1.9.0" }

output "gateway_image" { value = "maximhq/bifrost:v2.3.2@sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7" }

output "postgres_client_image" { value = "postgres:18" }

output "server_environment" {
  value = {
    SPYRIA_DEPLOYMENT             = var.name
    SPYRIA_AUTH_MODE              = "sso"
    SPYRIA_APP_ORIGIN             = local.origin
    SPYRIA_OIDC_REDIRECT_URI      = "${local.origin}/auth/callback"
    SPYRIA_JOIN_BY                = var.join_by
    SPYRIA_TRUSTED_PROXY          = var.trusted_proxy
    SPYRIA_GATEWAY_URL            = var.gateway_url
    SPYRIA_ZERO_URL               = var.zero_url
    SPYRIA_MAIL_FROM              = var.mail_from
    SPYRIA_GOOGLE_CLIENT_ID       = var.google_client_id
    SPYRIA_MICROSOFT_CLIENT_ID    = var.microsoft_client_id
    SPYRIA_SIGN_IN_APP_CLIENT_ID  = var.sign_in_app_client_id
    DATABASE_POOL_MAX             = "20"
    DATABASE_IDLE_TIMEOUT_SECONDS = "60"
    DATABASE_MAX_LIFETIME_SECONDS = "1800"
    DATABASE_APPLICATION_NAME     = "spyria-server"
  }
}

output "server_secrets" {
  sensitive = true
  value = {
    DATABASE_URL                     = local.database_url
    SPYRIA_TOKEN_SECRET              = var.secrets.token_secret
    SPYRIA_SECRETS_KEY               = var.secrets.secrets_key
    SPYRIA_SETUP_TOKEN               = var.secrets.setup_token
    SPYRIA_INSTALL_HOST_TOKEN        = var.secrets.install_host_token
    SPYRIA_GATEWAY_ADMIN_USER        = var.secrets.gateway_admin_user
    SPYRIA_GATEWAY_ADMIN_PASSWORD    = var.secrets.gateway_admin_password
    SPYRIA_SMTP_URL                  = var.smtp_url
    SPYRIA_GOOGLE_CLIENT_SECRET      = var.google_client_secret
    SPYRIA_MICROSOFT_CLIENT_SECRET   = var.microsoft_client_secret
    SPYRIA_SIGN_IN_APP_CLIENT_SECRET = var.sign_in_app_client_secret
  }
}

output "migrate_command" { value = ["bun", "run", "--cwd", "packages/db", "migrate"] }

output "zero_environment" {
  value = {
    ZERO_APP_ID             = "spyria"
    ZERO_APP_PUBLICATIONS   = "spyria_zero"
    ZERO_UPSTREAM_MAX_CONNS = "20"
    ZERO_CVR_MAX_CONNS      = "30"
    ZERO_CHANGE_MAX_CONNS   = "5"
    ZERO_QUERY_URL          = "${var.server_url}/api/query"
    ZERO_MUTATE_URL         = "${var.server_url}/api/mutate"
    ZERO_PORT               = "4848"
    ZERO_REPLICA_FILE       = var.zero_replica_file
    ZERO_ENABLE_TELEMETRY   = "false"
  }
}

output "zero_secrets" {
  sensitive = true
  value = {
    ZERO_UPSTREAM_DB    = local.database_url
    ZERO_ADMIN_PASSWORD = var.secrets.zero_admin_password
  }
}

output "gateway_environment" {
  value = {
    SPYRIA_GATEWAY_OAUTH_BASE = "${local.origin}/gateway-oauth"
    BIFROST_CONFIG = jsonencode(merge(jsondecode(file("${path.module}/../../../../bifrost.json")), {
      config_store = { enabled = true, type = "postgres", config = local.gateway_store }
      logs_store   = { enabled = true, type = "postgres", config = local.gateway_store }
    }))
  }
}

output "gateway_secrets" {
  sensitive = true
  value = {
    BIFROST_ENCRYPTION_KEY = var.secrets.gateway_encryption_key
    BIFROST_SETUP_TOKEN    = var.secrets.gateway_setup_token
    BIFROST_ADMIN_USER     = var.secrets.gateway_admin_user
    BIFROST_ADMIN_PASSWORD = var.secrets.gateway_admin_password
    BIFROST_DB_PASSWORD    = var.secrets.gateway_database_password
    PGPASSWORD             = var.secrets.database_password
  }
}

output "gateway_config_command" {
  description = "Writes the gateway configuration from BIFROST_CONFIG, then creates its role and database once, in the managed Postgres"
  value = [
    "sh",
    "-ec",
    join("\n", [
      "printf '%s' \"$BIFROST_CONFIG\" > /app/data/config.json",
      "export PGHOST=${var.database.host} PGPORT=${var.database.port} PGUSER=${var.database.user} PGDATABASE=${var.database.spyria_name} PGSSLMODE=${var.database.requires_tls ? "require" : "disable"}",
      "psql -tAc \"select 1 from pg_roles where rolname = 'bifrost'\" | grep -q 1 || psql -c \"create role bifrost login password '$BIFROST_DB_PASSWORD'\"",
      "psql -c \"grant bifrost to current_user\"",
      var.database.replication_grant,
      "psql -tAc \"select 1 from pg_database where datname = '${var.database.gateway_name}'\" | grep -q 1 || psql -c \"create database ${var.database.gateway_name} owner bifrost template template0 encoding 'UTF8'\"",
    ]),
  ]
}

output "setup_link" {
  sensitive = true
  value     = "${local.origin}/?setup=${var.secrets.setup_token}"
}

output "install_host_claim_url" {
  description = "The claim URL a runtime host pairs with the first workspace through, once"
  sensitive   = true
  value       = "${local.origin}/h/${var.secrets.install_host_token}"
}

output "gateway_config_script" {
  description = "Bun script for the clouds without init containers: writes the gateway configuration, creates its role and database, then answers on port 9000 so the gateway starts after it"
  value       = <<-SCRIPT
    await Bun.write('/app/data/config.json', process.env.BIFROST_CONFIG)
    const sql = new Bun.SQL(process.env.DATABASE_URL)
    const password = process.env.BIFROST_DB_PASSWORD
    if (!/^[A-Za-z0-9]+$/.test(password)) throw new Error('The gateway database password takes letters and digits only')
    if ((await sql`select 1 from pg_roles where rolname = 'bifrost'`).length === 0)
      await sql.unsafe(`create role bifrost login password '$${password}'`)
    await sql.unsafe('grant bifrost to current_user')
    ${var.database.replication_grant == "" ? "" : "await sql.unsafe('alter role current_user with replication')"}
    if ((await sql`select 1 from pg_database where datname = '${var.database.gateway_name}'`).length === 0)
      await sql.unsafe(`create database ${var.database.gateway_name} owner bifrost template template0 encoding 'UTF8'`)
    await sql.end()
    Bun.serve({ port: 9000, fetch: () => new Response('configured') })
  SCRIPT
}

output "server_command" {
  description = "Runs the migrations, then the server, for the clouds without init containers"
  value       = ["sh", "-c", "bun run --cwd packages/db migrate && exec bun apps/server/src/index.ts"]
}

terraform {
  required_version = ">= 1.8"
  required_providers {
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  secret_names = [
    "token_secret",
    "secrets_key",
    "setup_token",
    "gateway_admin_password",
    "gateway_encryption_key",
    "gateway_setup_token",
    "gateway_database_password",
    "database_password",
    "zero_admin_password",
  ]
}

resource "random_password" "secret" {
  for_each = toset(local.secret_names)
  length   = 48
  special  = false
}

resource "random_string" "gateway_admin_user" {
  length  = 8
  special = false
  upper   = false
}

resource "random_string" "install_host_token" {
  length           = 16
  upper            = false
  lower            = false
  numeric          = false
  special          = true
  override_special = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
}

output "values" {
  description = "Every secret of the deployment, generated once and kept in the state"
  sensitive   = true
  value = merge(
    { for name, secret in random_password.secret : name => secret.result },
    {
      gateway_admin_user = "admin-${random_string.gateway_admin_user.result}"
      install_host_token = random_string.install_host_token.result
    },
  )
}

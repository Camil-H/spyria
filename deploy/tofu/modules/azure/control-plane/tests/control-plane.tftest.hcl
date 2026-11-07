mock_provider "time" {}

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = { tenant_id = "00000000-0000-0000-0000-000000000001", object_id = "00000000-0000-0000-0000-000000000002" }
  }
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/virtualNetworks/spyria" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/virtualNetworks/spyria/subnets/apps" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/privateDnsZones/spyria.private.postgres.database.azure.com" }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.DBforPostgreSQL/flexibleServers/spyria-abc"
      fqdn = "spyria-abc.private.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_key_vault" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.KeyVault/vaults/spyria-abc" }
  }
  mock_resource "azurerm_key_vault_secret" {
    defaults = { versionless_id = "https://spyria-abc.vault.azure.net/secrets/setting" }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.ManagedIdentity/userAssignedIdentities/spyria-apps"
      principal_id = "00000000-0000-0000-0000-000000000003"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.OperationalInsights/workspaces/spyria" }
  }
  mock_resource "azurerm_role_assignment" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000009" }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.App/managedEnvironments/spyria" }
  }
  mock_resource "azurerm_container_app" {
    defaults = {
      id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.App/containerApps/spyria-server"
      custom_domain_verification_id = "VERIFICATION"
    }
  }
  mock_resource "azurerm_container_app_environment_managed_certificate" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.App/managedEnvironments/spyria/managedCertificates/spyria-example-com" }
  }
}

variables {
  hostname                = "spyria.example.com"
  spyria_version          = "1.2.0"
  smtp_url                = "smtps://user:pass@smtp.example.com:465"
  mail_from               = "Spyria <spyria@example.com>"
  dns_zone_name           = "example.com"
  dns_zone_resource_group = "dns"
}

run "the_control_plane_runs_one_server_with_public_ingress_and_keeps_the_rest_internal" {
  command = apply
  assert {
    condition     = azurerm_container_app.server.template[0].min_replicas == 1 && azurerm_container_app.server.template[0].max_replicas == 1
    error_message = "Exactly one server replica runs"
  }
  assert {
    condition     = azurerm_container_app.server.ingress[0].external_enabled && !azurerm_container_app.gateway.ingress[0].external_enabled && !azurerm_container_app.zero.ingress[0].external_enabled
    error_message = "Only the server is public: the gateway and zero-cache answer inside the environment"
  }
  assert {
    condition     = azurerm_postgresql_flexible_server_configuration.setting["wal_level"].value == "logical" && azurerm_postgresql_flexible_server.postgres.version == "18" && !azurerm_postgresql_flexible_server.postgres.public_network_access_enabled
    error_message = "Postgres 18 with logical replication, reachable from the network alone"
  }
  assert {
    condition     = azurerm_management_lock.postgres.lock_level == "CanNotDelete"
    error_message = "The database cannot be deleted by accident"
  }
  assert {
    condition     = azurerm_container_app.zero.template[0].volume[0].storage_type == "EmptyDir"
    error_message = "zero-cache keeps its replica on local storage"
  }
  assert {
    condition     = module.settings.zero_environment.ZERO_QUERY_URL == "https://${azurerm_container_app.server.ingress[0].fqdn}/api/query" && azurerm_container_app.zero.ingress[0].allow_insecure_connections
    error_message = "zero-cache calls the server over HTTPS, and the server calls the internal apps over plain HTTP inside the environment"
  }
  assert {
    condition     = azurerm_container_app.server.template[0].container[0].readiness_probe[0].path == "/health/live"
    error_message = "The platform judges the server by its own liveness, not zero-cache's or the gateway's"
  }
  assert {
    condition     = contains([for secret in azurerm_container_app.server.secret : secret.name], "spyria-smtp-url") && !contains(keys(azurerm_key_vault_secret.setting), "SPYRIA_GOOGLE_CLIENT_SECRET")
    error_message = "Set secrets live in Key Vault; unset optional ones are left out"
  }
  assert {
    condition     = alltrue([for secret in azurerm_container_app.server.secret : secret.key_vault_secret_id != null])
    error_message = "The apps read their secrets from Key Vault"
  }
  assert {
    condition     = azurerm_dns_cname_record.hostname[0].name == "spyria" && azurerm_dns_txt_record.verification[0].name == "asuid.spyria"
    error_message = "With an Azure DNS zone the module creates the hostname's records"
  }
  assert {
    condition     = azurerm_container_app_custom_domain.hostname[0].name == "spyria.example.com" && output.certificate_command == "az containerapp hostname bind --resource-group spyria --name spyria-server --environment spyria --hostname spyria.example.com --validation-method CNAME"
    error_message = "The hostname is added to the server, and one az command binds its managed certificate"
  }
  assert {
    condition     = startswith(output.setup_link, "https://spyria.example.com/?setup=")
    error_message = "The setup link carries the setup token"
  }
}

run "without_an_azure_dns_zone_it_names_the_records_and_can_wait_to_bind" {
  command = apply
  variables {
    dns_zone_name  = ""
    binds_hostname = false
  }
  assert {
    condition     = length(output.dns_records) == 2 && output.dns_records[1].name == "asuid.spyria.example.com" && output.dns_records[1].value == "VERIFICATION"
    error_message = "The CNAME and the verification TXT are named"
  }
  assert {
    condition     = length(azurerm_container_app_custom_domain.hostname) == 0
    error_message = "The hostname waits for its records before binding"
  }
}

run "a_dns_zone_needs_its_resource_group" {
  command = plan
  variables {
    dns_zone_resource_group = ""
  }
  expect_failures = [var.dns_zone_resource_group]
}

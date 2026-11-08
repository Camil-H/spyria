locals {
  secret_values = merge(
    module.settings.server_secrets,
    module.settings.zero_secrets,
    module.settings.gateway_secrets,
  )
  optional_secrets = {
    SPYRIA_SMTP_URL                  = var.smtp_url
    SPYRIA_GOOGLE_CLIENT_SECRET      = var.google_client_secret
    SPYRIA_MICROSOFT_CLIENT_SECRET   = var.microsoft_client_secret
    SPYRIA_SIGN_IN_APP_CLIENT_SECRET = var.sign_in_app_client_secret
  }
  unset_secrets   = [for name, value in local.optional_secrets : name if nonsensitive(value == "")]
  secret_names    = setsubtract(nonsensitive(keys(local.secret_values)), local.unset_secrets)
  vault_secret_of = { for name in local.secret_names : name => lower(replace(name, "_", "-")) }
}

resource "azurerm_key_vault" "settings" {
  name                       = "${var.name}-${random_string.suffix.result}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
}

resource "azurerm_role_assignment" "deployer_writes_secrets" {
  for_each             = toset(concat([data.azurerm_client_config.current.object_id], var.secret_admin_object_ids))
  scope                = azurerm_key_vault.settings.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

resource "azurerm_user_assigned_identity" "apps" {
  name                = "${var.name}-apps"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_role_assignment" "apps_read_secrets" {
  scope                = azurerm_key_vault.settings.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.apps.principal_id
}

resource "azurerm_key_vault_secret" "setting" {
  for_each     = local.secret_names
  name         = local.vault_secret_of[each.key]
  value        = local.secret_values[each.key]
  key_vault_id = azurerm_key_vault.settings.id
  depends_on   = [time_sleep.deployer_role_propagates]
}

resource "time_sleep" "deployer_role_propagates" {
  create_duration = "120s"
  depends_on      = [azurerm_role_assignment.deployer_writes_secrets]
}

resource "time_sleep" "apps_role_propagates" {
  create_duration = "120s"
  depends_on      = [azurerm_role_assignment.apps_read_secrets]
}

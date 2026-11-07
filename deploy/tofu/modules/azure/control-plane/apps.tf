locals {
  secret_refs_of = {
    migrate        = ["DATABASE_URL"]
    server         = nonsensitive(keys(module.settings.server_secrets))
    zero           = nonsensitive(keys(module.settings.zero_secrets))
    gateway        = [for name in nonsensitive(keys(module.settings.gateway_secrets)) : name if name != "PGPASSWORD"]
    gateway_config = ["BIFROST_DB_PASSWORD", "PGPASSWORD"]
  }
  app_secrets_of = {
    server  = setintersection(local.secret_names, concat(local.secret_refs_of.server, local.secret_refs_of.migrate))
    zero    = setintersection(local.secret_names, local.secret_refs_of.zero)
    gateway = setintersection(local.secret_names, concat(local.secret_refs_of.gateway, local.secret_refs_of.gateway_config))
  }
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = var.name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "main" {
  name                       = var.name
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app" "server" {
  name                         = local.app_names.server
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }
  dynamic "secret" {
    for_each = local.app_secrets_of.server
    content {
      name                = local.vault_secret_of[secret.value]
      key_vault_secret_id = azurerm_key_vault_secret.setting[secret.value].versionless_id
      identity            = azurerm_user_assigned_identity.apps.id
    }
  }
  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas                     = 1
    max_replicas                     = 1
    termination_grace_period_seconds = 30
    init_container {
      name    = "migrate"
      image   = module.settings.server_image
      command = module.settings.migrate_command
      cpu     = 0.5
      memory  = "1Gi"
      env {
        name        = "DATABASE_URL"
        secret_name = local.vault_secret_of["DATABASE_URL"]
      }
    }
    container {
      name   = "server"
      image  = module.settings.server_image
      cpu    = local.size.cpu
      memory = local.size.memory
      dynamic "env" {
        for_each = module.settings.server_environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = setintersection(local.secret_names, local.secret_refs_of.server)
        content {
          name        = env.value
          secret_name = local.vault_secret_of[env.value]
        }
      }
      readiness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/health/live"
      }
    }
  }
  depends_on = [time_sleep.apps_role_propagates]
}

resource "azurerm_container_app" "zero" {
  name                         = local.app_names.zero
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }
  dynamic "secret" {
    for_each = local.app_secrets_of.zero
    content {
      name                = local.vault_secret_of[secret.value]
      key_vault_secret_id = azurerm_key_vault_secret.setting[secret.value].versionless_id
      identity            = azurerm_user_assigned_identity.apps.id
    }
  }
  ingress {
    external_enabled           = false
    target_port                = 4848
    allow_insecure_connections = true
    transport                  = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas = 1
    max_replicas = 1
    volume {
      name         = "replica"
      storage_type = "EmptyDir"
    }
    container {
      name   = "zero-cache"
      image  = module.settings.zero_image
      cpu    = 1.0
      memory = "2Gi"
      dynamic "env" {
        for_each = module.settings.zero_environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.app_secrets_of.zero
        content {
          name        = env.value
          secret_name = local.vault_secret_of[env.value]
        }
      }
      volume_mounts {
        name = "replica"
        path = "/data"
      }
    }
  }
  depends_on = [time_sleep.apps_role_propagates]
}

resource "azurerm_container_app" "gateway" {
  name                         = local.app_names.gateway
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.apps.id]
  }
  dynamic "secret" {
    for_each = local.app_secrets_of.gateway
    content {
      name                = local.vault_secret_of[secret.value]
      key_vault_secret_id = azurerm_key_vault_secret.setting[secret.value].versionless_id
      identity            = azurerm_user_assigned_identity.apps.id
    }
  }
  ingress {
    external_enabled           = false
    target_port                = 8080
    allow_insecure_connections = true
    transport                  = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
  template {
    min_replicas = 1
    max_replicas = 1
    volume {
      name         = "gateway-data"
      storage_type = "EmptyDir"
    }
    init_container {
      name    = "configure"
      image   = module.settings.postgres_client_image
      command = module.settings.gateway_config_command
      cpu     = 0.25
      memory  = "0.5Gi"
      dynamic "env" {
        for_each = module.settings.gateway_environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_refs_of.gateway_config
        content {
          name        = env.value
          secret_name = local.vault_secret_of[env.value]
        }
      }
      volume_mounts {
        name = "gateway-data"
        path = "/app/data"
      }
    }
    container {
      name   = "gateway"
      image  = module.settings.gateway_image
      cpu    = 0.5
      memory = "1Gi"
      dynamic "env" {
        for_each = module.settings.gateway_environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_refs_of.gateway
        content {
          name        = env.value
          secret_name = local.vault_secret_of[env.value]
        }
      }
      volume_mounts {
        name = "gateway-data"
        path = "/app/data"
      }
    }
  }
  depends_on = [time_sleep.apps_role_propagates]
}

resource "azurerm_dns_cname_record" "hostname" {
  count               = local.manages_dns ? 1 : 0
  name                = local.record_name
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  record              = azurerm_container_app.server.ingress[0].fqdn
}

resource "azurerm_dns_txt_record" "verification" {
  count               = local.manages_dns ? 1 : 0
  name                = "asuid.${local.record_name}"
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  record {
    value = azurerm_container_app.server.custom_domain_verification_id
  }
}

resource "azurerm_container_app_custom_domain" "hostname" {
  count            = var.binds_hostname ? 1 : 0
  name             = var.hostname
  container_app_id = azurerm_container_app.server.id
  depends_on       = [azurerm_dns_cname_record.hostname, azurerm_dns_txt_record.verification]
  lifecycle {
    ignore_changes = [certificate_binding_type, container_app_environment_certificate_id]
  }
}

data "azurerm_client_config" "current" {}

locals {
  sizes = {
    small  = { cpu = 1.0, memory = "2Gi", database_sku = "GP_Standard_D2ds_v5" }
    medium = { cpu = 2.0, memory = "4Gi", database_sku = "GP_Standard_D4ds_v5" }
    large  = { cpu = 4.0, memory = "8Gi", database_sku = "GP_Standard_D8ds_v5" }
  }
  size          = local.sizes[var.size]
  manages_dns   = var.dns_zone_name != ""
  record_name   = trimsuffix(trimsuffix(var.hostname, var.dns_zone_name), ".")
  app_names     = { server = "${var.name}-server", zero = "${var.name}-zero-cache", gateway = "${var.name}-gateway" }
  database_host = azurerm_postgresql_flexible_server.postgres.fqdn
}

resource "azurerm_resource_group" "main" {
  name     = var.name
  location = var.location
}

module "secrets" {
  source = "../../shared/secrets"
}

module "settings" {
  source                  = "../../shared/settings"
  name                    = var.name
  hostname                = var.hostname
  spyria_version          = var.spyria_version
  images                  = var.images
  join_by                 = var.join_by
  smtp_url                = var.smtp_url
  mail_from               = var.mail_from
  google_client_id        = var.google_client_id
  google_client_secret    = var.google_client_secret
  microsoft_client_id     = var.microsoft_client_id
  microsoft_client_secret = var.microsoft_client_secret
  secrets                 = module.secrets.values
  database = {
    host              = local.database_host
    port              = 5432
    user              = "spyria"
    requires_tls      = true
    replication_grant = "psql -c \"alter role spyria with replication\""
    spyria_name       = "spyria"
    gateway_name      = "bifrost"
  }
  server_url        = "http://${local.app_names.server}"
  zero_url          = "http://${local.app_names.zero}"
  gateway_url       = "http://${local.app_names.gateway}"
  zero_replica_file = "/data/spyria-replica.db"
}

resource "azurerm_virtual_network" "main" {
  name                = var.name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.41.0.0/16"]
}

resource "azurerm_subnet" "apps" {
  name                 = "apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.41.0.0/23"]
  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "database" {
  name                 = "database"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.41.4.0/24"]
  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "hosts" {
  name                 = "runtime-hosts"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.41.8.0/24"]
}

resource "azurerm_private_dns_zone" "database" {
  name                = "${var.name}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "database" {
  name                  = "database"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.database.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

resource "azurerm_postgresql_flexible_server" "postgres" {
  name                          = "${var.name}-${random_string.suffix.result}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "18"
  sku_name                      = local.size.database_sku
  storage_mb                    = 32768
  auto_grow_enabled             = true
  backup_retention_days         = 7
  administrator_login           = "spyria"
  administrator_password        = module.secrets.values.database_password
  delegated_subnet_id           = azurerm_subnet.database.id
  private_dns_zone_id           = azurerm_private_dns_zone.database.id
  public_network_access_enabled = false
  depends_on                    = [azurerm_private_dns_zone_virtual_network_link.database]
  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_configuration" "setting" {
  for_each  = { wal_level = "logical", max_slot_wal_keep_size = "10240" }
  name      = each.key
  server_id = azurerm_postgresql_flexible_server.postgres.id
  value     = each.value
}

resource "azurerm_postgresql_flexible_server_database" "spyria" {
  name      = "spyria"
  server_id = azurerm_postgresql_flexible_server.postgres.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_management_lock" "postgres" {
  name       = "keep-the-database"
  scope      = azurerm_postgresql_flexible_server.postgres.id
  lock_level = "CanNotDelete"
  notes      = "Spyria's data: remove this lock deliberately before deleting the server"
}

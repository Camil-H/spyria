data "aws_region" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  sizes = {
    small  = { cpu = 1024, memory = 2048, database_class = "db.t4g.small" }
    medium = { cpu = 2048, memory = 4096, database_class = "db.t4g.medium" }
    large  = { cpu = 4096, memory = 8192, database_class = "db.m7g.large" }
  }
  size        = local.sizes[var.size]
  zones       = slice(data.aws_availability_zones.available.names, 0, 2)
  namespace   = "${var.name}.internal"
  manages_dns = var.route53_zone_id != ""
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
    host              = aws_db_instance.postgres.address
    port              = aws_db_instance.postgres.port
    user              = "spyria"
    requires_tls      = true
    replication_grant = ""
    spyria_name       = "spyria"
    gateway_name      = "bifrost"
  }
  server_url        = "http://server.${local.namespace}:3000"
  zero_url          = "http://zero-cache.${local.namespace}:4848"
  gateway_url       = "http://gateway.${local.namespace}:8080"
  zero_replica_file = "/data/spyria-replica.db"
  trusted_proxy     = "x-forwarded-for:1"
}

data "google_project" "current" {
  project_id = var.project
}

locals {
  sizes = {
    small  = { cpu = "1", memory = "2Gi", database_tier = "db-custom-2-7680" }
    medium = { cpu = "2", memory = "4Gi", database_tier = "db-custom-4-15360" }
    large  = { cpu = "4", memory = "8Gi", database_tier = "db-custom-8-30720" }
  }
  size          = local.sizes[var.size]
  service_names = { server = "${var.name}-server", zero = "${var.name}-zero-cache", gateway = "${var.name}-gateway" }
  service_url   = { for service, name in local.service_names : service => "https://${name}-${data.google_project.current.number}.${var.region}.run.app" }
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "dns.googleapis.com",
  ]
  ghcr_mirror  = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.ghcr.repository_id}"
  images_path  = trimprefix(var.images, "ghcr.io/")
  server_image = startswith(var.images, "ghcr.io/") ? "${local.ghcr_mirror}/${local.images_path}/spyria-server:${var.spyria_version}" : module.settings.server_image
}

resource "google_project_service" "api" {
  for_each           = toset(local.apis)
  project            = var.project
  service            = each.key
  disable_on_destroy = false
}

module "secrets" {
  source = "../../shared/secrets"
}

module "settings" {
  source                    = "../../shared/settings"
  name                      = var.name
  hostname                  = var.hostname
  spyria_version            = var.spyria_version
  images                    = var.images
  join_by                   = var.join_by
  smtp_url                  = var.smtp_url
  mail_from                 = var.mail_from
  google_client_id          = var.google_client_id
  google_client_secret      = var.google_client_secret
  microsoft_client_id       = var.microsoft_client_id
  microsoft_client_secret   = var.microsoft_client_secret
  sign_in_app_client_id     = var.sign_in_app_client_id
  sign_in_app_client_secret = var.sign_in_app_client_secret
  secrets                   = module.secrets.values
  database = {
    host              = google_sql_database_instance.postgres.private_ip_address
    port              = 5432
    user              = "spyria"
    requires_tls      = true
    replication_grant = "psql -c \"alter role spyria with replication\""
    spyria_name       = "spyria"
    gateway_name      = "bifrost"
  }
  server_url        = local.service_url.server
  zero_url          = local.service_url.zero
  gateway_url       = local.service_url.gateway
  zero_replica_file = "/data/spyria-replica.db"
  trusted_proxy     = "x-forwarded-for:2"
}

resource "google_compute_network" "main" {
  project                 = var.project
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.api]
}

resource "google_compute_subnetwork" "main" {
  project                  = var.project
  name                     = var.name
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = "10.42.0.0/20"
  private_ip_google_access = true
}

resource "google_compute_subnetwork" "hosts" {
  project       = var.project
  name          = "${var.name}-runtime-hosts"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.42.16.0/20"
}

resource "google_compute_router" "main" {
  project = var.project
  name    = var.name
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  project                            = var.project
  name                               = var.name
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "google_compute_global_address" "database_peering" {
  project       = var.project
  name          = "${var.name}-database"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "database" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.database_peering.name]
}

resource "google_sql_database_instance" "postgres" {
  project             = var.project
  name                = var.name
  region              = var.region
  database_version    = "POSTGRES_18"
  deletion_protection = true
  depends_on          = [google_service_networking_connection.database]
  settings {
    tier              = local.size.database_tier
    edition           = "ENTERPRISE"
    disk_autoresize   = true
    disk_size         = 20
    availability_type = "ZONAL"
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    database_flags {
      name  = "cloudsql.logical_decoding"
      value = "on"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }
  lifecycle {
    ignore_changes = [settings[0].disk_size]
  }
}

resource "google_sql_database" "spyria" {
  project  = var.project
  name     = "spyria"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "spyria" {
  project  = var.project
  name     = "spyria"
  instance = google_sql_database_instance.postgres.name
  password = module.secrets.values.database_password
}

resource "google_artifact_registry_repository" "ghcr" {
  project       = var.project
  location      = var.region
  repository_id = "${var.name}-ghcr"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  description   = "Mirrors ghcr.io, which Cloud Run cannot pull from"
  remote_repository_config {
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
  }
  depends_on = [google_project_service.api]
}

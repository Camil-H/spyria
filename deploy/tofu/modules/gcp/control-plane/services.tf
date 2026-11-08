locals {
  vpc_access = { network = google_compute_network.main.id, subnetwork = google_compute_subnetwork.main.id }
}

locals {
  secret_versions = {
    SPYRIA_SECRET_VERSIONS = join(",", [for name in sort(local.secret_names) : google_secret_manager_secret_version.setting[name].version])
  }
}

resource "google_cloud_run_v2_service" "server" {
  project              = var.project
  name                 = local.service_names.server
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection  = false
  invoker_iam_disabled = true
  template {
    service_account                  = google_service_account.services.email
    timeout                          = "3600s"
    session_affinity                 = true
    max_instance_request_concurrency = 1000
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
    }
    containers {
      image   = local.server_image
      command = module.settings.server_command
      ports {
        container_port = 3000
      }
      resources {
        cpu_idle = false
        limits   = { cpu = local.size.cpu, memory = local.size.memory }
      }
      dynamic "env" {
        for_each = merge(module.settings.server_environment, local.secret_versions)
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.service_secret_names.server
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.setting[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 60
        http_get {
          path = "/health/live"
        }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.services_read,
    google_secret_manager_secret_version.setting,
    google_sql_database.spyria,
    google_sql_user.spyria,
  ]
}

resource "google_cloud_run_v2_service" "zero" {
  project              = var.project
  name                 = local.service_names.zero
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection  = false
  invoker_iam_disabled = true
  template {
    service_account                  = google_service_account.services.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 1000
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
    }
    volumes {
      name = "replica"
      empty_dir {
        medium     = "MEMORY"
        size_limit = "2Gi"
      }
    }
    containers {
      image = module.settings.zero_image
      ports {
        container_port = 4848
      }
      resources {
        cpu_idle = false
        limits   = { cpu = "1", memory = "4Gi" }
      }
      volume_mounts {
        name       = "replica"
        mount_path = "/data"
      }
      dynamic "env" {
        for_each = merge(module.settings.zero_environment, local.secret_versions)
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.service_secret_names.zero
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.setting[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.services_read,
    google_secret_manager_secret_version.setting,
    google_cloud_run_v2_service.server,
    google_cloud_run_v2_service.gateway,
  ]
}

resource "google_cloud_run_v2_service" "gateway" {
  project              = var.project
  name                 = local.service_names.gateway
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection  = false
  invoker_iam_disabled = true
  template {
    service_account                  = google_service_account.services.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 1000
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
    }
    volumes {
      name = "gateway-data"
      empty_dir {
        medium     = "MEMORY"
        size_limit = "256Mi"
      }
    }
    containers {
      name    = "configure"
      image   = local.server_image
      command = ["bun", "-e", module.settings.gateway_config_script]
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      volume_mounts {
        name       = "gateway-data"
        mount_path = "/app/data"
      }
      env {
        name  = "BIFROST_CONFIG"
        value = module.settings.gateway_environment.BIFROST_CONFIG
      }
      env {
        name  = "SPYRIA_SECRET_VERSIONS"
        value = local.secret_versions.SPYRIA_SECRET_VERSIONS
      }
      dynamic "env" {
        for_each = local.service_secret_names.configure
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.setting[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        period_seconds    = 2
        failure_threshold = 60
        tcp_socket {
          port = 9000
        }
      }
    }
    containers {
      name       = "gateway"
      image      = module.settings.gateway_image
      depends_on = ["configure"]
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
      volume_mounts {
        name       = "gateway-data"
        mount_path = "/app/data"
      }
      env {
        name  = "SPYRIA_GATEWAY_OAUTH_BASE"
        value = module.settings.gateway_environment.SPYRIA_GATEWAY_OAUTH_BASE
      }
      env {
        name  = "SPYRIA_SECRET_VERSIONS"
        value = local.secret_versions.SPYRIA_SECRET_VERSIONS
      }
      dynamic "env" {
        for_each = local.service_secret_names.gateway
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.setting[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.services_read,
    google_secret_manager_secret_version.setting,
    google_sql_database.spyria,
    google_sql_user.spyria,
  ]
}

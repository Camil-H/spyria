locals {
  vpc_access     = { network = google_compute_network.main.id, subnetwork = google_compute_subnetwork.main.id }
  secrets_digest = { SPYRIA_SECRETS_DIGEST = nonsensitive(sha256(jsonencode(local.secret_values))) }
}

resource "google_cloud_run_v2_service" "server" {
  project              = var.project
  name                 = local.service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  default_uri_disabled = true
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
    volumes {
      name = "replica"
      empty_dir {
        medium     = "MEMORY"
        size_limit = local.size.zero_replica
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
      name    = "server"
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
        for_each = merge(module.settings.server_environment, local.secrets_digest)
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
          port = 3000
        }
      }
    }
    containers {
      name       = "zero-cache"
      image      = module.settings.zero_image
      depends_on = ["server"]
      resources {
        cpu_idle = false
        limits   = { cpu = local.size.zero_cpu, memory = local.size.zero_memory }
      }
      startup_probe {
        period_seconds    = 10
        timeout_seconds   = 5
        failure_threshold = 60
        tcp_socket {
          port = 4848
        }
      }
      volume_mounts {
        name       = "replica"
        mount_path = "/data"
      }
      dynamic "env" {
        for_each = merge(module.settings.zero_environment, local.secrets_digest)
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
    containers {
      name    = "configure"
      image   = local.server_image
      command = ["bun", "-e", module.settings.gateway_config_script]
      resources {
        cpu_idle = false
        limits   = { cpu = "1", memory = "512Mi" }
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
        name  = "SPYRIA_SECRETS_DIGEST"
        value = local.secrets_digest.SPYRIA_SECRETS_DIGEST
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
      resources {
        cpu_idle = false
        limits   = { cpu = "1", memory = "1Gi" }
      }
      startup_probe {
        period_seconds    = 2
        failure_threshold = 60
        tcp_socket {
          port = 8080
        }
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
        name  = "SPYRIA_SECRETS_DIGEST"
        value = local.secrets_digest.SPYRIA_SECRETS_DIGEST
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

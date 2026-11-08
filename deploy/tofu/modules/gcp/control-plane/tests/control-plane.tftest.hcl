mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_resource "google_compute_network" {
    defaults = { id = "projects/project/global/networks/spyria" }
  }
  mock_resource "google_compute_subnetwork" {
    defaults = { id = "projects/project/regions/europe-west1/subnetworks/spyria" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { private_ip_address = "10.50.0.3" }
  }
  mock_resource "google_compute_global_address" {
    defaults = { address = "203.0.113.10" }
  }
  mock_resource "google_service_account" {
    defaults = { email = "spyria-services@project.iam.gserviceaccount.com" }
  }
}

variables {
  hostname       = "spyria.example.com"
  spyria_version = "1.2.0"
  project        = "project"
  dns_zone_name  = "example-com"
}

run "the_control_plane_runs_one_always_allocated_server_behind_the_load_balancer_and_keeps_the_rest_internal" {
  command = apply
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].scaling[0].min_instance_count == 1 && google_cloud_run_v2_service.server.template[0].scaling[0].max_instance_count == 1
    error_message = "Exactly one server instance runs"
  }
  assert {
    condition     = !google_cloud_run_v2_service.server.template[0].containers[0].resources[0].cpu_idle && google_cloud_run_v2_service.server.template[0].session_affinity && google_cloud_run_v2_service.server.template[0].timeout == "3600s"
    error_message = "The server keeps its CPU between requests, keeps a client on one instance and holds WebSockets for an hour"
  }
  assert {
    condition     = google_cloud_run_v2_service.server.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" && google_cloud_run_v2_service.gateway.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" && google_cloud_run_v2_service.zero.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    error_message = "The server is reached through the load balancer, the gateway and zero-cache from the network alone"
  }
  assert {
    condition     = google_sql_database_instance.postgres.database_version == "POSTGRES_18" && one([for flag in google_sql_database_instance.postgres.settings[0].database_flags : flag.value if flag.name == "cloudsql.logical_decoding"]) == "on" && !google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled
    error_message = "Postgres 18 with logical decoding, on a private address alone"
  }
  assert {
    condition     = tolist(google_cloud_run_v2_service.gateway.template[0].containers[1].depends_on) == tolist(["configure"])
    error_message = "The gateway starts once its configuration and database exist"
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].containers[0].image == "europe-west1-docker.pkg.dev/project/spyria-ghcr/camil-h/spyria-server:1.2.0" && google_artifact_registry_repository.ghcr.mode == "REMOTE_REPOSITORY"
    error_message = "Cloud Run pulls the published images through an Artifact Registry mirror of ghcr.io"
  }
  assert {
    condition     = google_compute_subnetwork.main.private_ip_google_access && !google_compute_subnetwork.hosts.private_ip_google_access && output.runtime_host_subnet_id == google_compute_subnetwork.hosts.id
    error_message = "The services reach each other privately; runtime hosts sit apart, without that private access"
  }
  assert {
    condition     = google_cloud_run_v2_service.gateway.template[0].timeout == "3600s" && google_cloud_run_v2_service.server.template[0].containers[0].startup_probe[0].http_get[0].path == "/health/live" && module.settings.server_environment.SPYRIA_TRUSTED_PROXY == "x-forwarded-for:2"
    error_message = "Streamed model calls last up to an hour, the platform judges the server by its own liveness, and rate limits key on the client behind Google's load balancer"
  }
  assert {
    condition     = module.settings.server_environment.SPYRIA_ZERO_URL == "https://spyria-zero-cache-123456789012.europe-west1.run.app"
    error_message = "The server reaches zero-cache at its Cloud Run address"
  }
  assert {
    condition     = tolist(google_dns_record_set.hostname[0].rrdatas) == tolist(["203.0.113.10"]) && length(output.dns_records) == 0
    error_message = "With a Cloud DNS zone the hostname points at the load balancer by itself"
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret.setting), "SPYRIA_SMTP_URL") && !contains(keys(google_secret_manager_secret.setting), "SPYRIA_SIGN_IN_APP_CLIENT_SECRET") && contains(keys(google_secret_manager_secret.setting), "SPYRIA_SECRETS_KEY")
    error_message = "Set secrets live in Secret Manager; unset optional ones are left out"
  }
  assert {
    condition     = startswith(output.setup_link, "https://spyria.example.com/?setup=")
    error_message = "The setup link carries the setup token"
  }
}

run "without_a_cloud_dns_zone_it_names_the_record_to_create" {
  command = apply
  variables {
    dns_zone_name = ""
  }
  assert {
    condition     = length(output.dns_records) == 1 && output.dns_records[0].value == "203.0.113.10" && output.dns_records[0].type == "A"
    error_message = "The hostname must point at the load balancer's address"
  }
}

run "a_sign_in_app_in_the_settings_reaches_the_server_with_its_secret_in_secret_manager" {
  command = apply
  variables {
    join_by                   = "invited-address"
    sign_in_app_client_id     = "garage-sign-in-app"
    sign_in_app_client_secret = "garage-secret"
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret.setting), "SPYRIA_SIGN_IN_APP_CLIENT_SECRET") && module.settings.server_environment.SPYRIA_SIGN_IN_APP_CLIENT_ID == "garage-sign-in-app"
    error_message = "The server gets the sign-in app's client id as a setting and its secret from Secret Manager"
  }
}

run "a_sign_in_app_takes_its_client_id_and_secret_together" {
  command = plan
  variables {
    sign_in_app_client_id = "garage-sign-in-app"
  }
  expect_failures = [var.sign_in_app_client_secret]
}

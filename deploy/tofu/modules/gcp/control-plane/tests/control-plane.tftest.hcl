mock_provider "google" {
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
    condition     = google_cloud_run_v2_service.server.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" && google_cloud_run_v2_service.server.default_uri_disabled && [for container in google_cloud_run_v2_service.server.template[0].containers : container.name if length(container.ports) > 0] == ["server"] && toset([for container in google_cloud_run_v2_service.server.template[0].containers : container.name]) == toset(["server", "zero-cache", "configure", "gateway"])
    error_message = "Spyria answers only through the load balancer: the server has no run.app address, and zero-cache and the gateway run beside it on localhost with no address of their own"
  }
  assert {
    condition     = google_sql_database_instance.postgres.database_version == "POSTGRES_18" && one([for flag in google_sql_database_instance.postgres.settings[0].database_flags : flag.value if flag.name == "cloudsql.logical_decoding"]) == "on" && !google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled
    error_message = "Postgres 18 with logical decoding, on a private address alone"
  }
  assert {
    condition     = tolist(one([for container in google_cloud_run_v2_service.server.template[0].containers : container if container.name == "gateway"]).depends_on) == tolist(["configure"]) && tolist(one([for container in google_cloud_run_v2_service.server.template[0].containers : container if container.name == "zero-cache"]).depends_on) == tolist(["server"])
    error_message = "The gateway starts once its configuration and database exist, and zero-cache once the server has migrated the database"
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].containers[0].image == "europe-west1-docker.pkg.dev/project/spyria-ghcr/camil-h/spyria-server:1.2.0" && google_artifact_registry_repository.ghcr.mode == "REMOTE_REPOSITORY"
    error_message = "Cloud Run pulls the published images through an Artifact Registry mirror of ghcr.io"
  }
  assert {
    condition     = google_compute_subnetwork.main.private_ip_google_access && output.runtime_host_subnet_id == google_compute_subnetwork.hosts.id && module.settings.server_environment.SPYRIA_ZERO_URL == "http://localhost:4848" && module.settings.server_environment.SPYRIA_GATEWAY_URL == "http://localhost:8080"
    error_message = "The server reaches Google's APIs privately and its sidecars on localhost; runtime hosts get a subnetwork of their own"
  }
  assert {
    condition     = google_cloud_run_v2_service.server.template[0].timeout == "3600s" && one([for container in google_cloud_run_v2_service.server.template[0].containers : container if container.name == "server"]).startup_probe[0].http_get[0].path == "/health/live" && module.settings.server_environment.SPYRIA_TRUSTED_PROXY == "x-forwarded-for:2"
    error_message = "Streamed model calls last up to an hour, the platform judges the server by its own liveness, and rate limits key on the client behind Google's load balancer"
  }
  assert {
    condition     = module.settings.zero_environment.ZERO_QUERY_URL == "http://localhost:3000/api/query" && module.settings.zero_environment.ZERO_MUTATE_URL == "http://localhost:3000/api/mutate"
    error_message = "zero-cache calls the server beside it on localhost"
  }
  assert {
    condition     = tolist(google_dns_record_set.hostname[0].rrdatas) == tolist(["203.0.113.10"]) && length(output.dns_records) == 0
    error_message = "With a Cloud DNS zone the hostname points at the load balancer by itself"
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret.setting), "SPYRIA_GOOGLE_CLIENT_SECRET") && !contains(keys(google_secret_manager_secret.setting), "SPYRIA_OIDC_CLIENT_SECRET") && contains(keys(google_secret_manager_secret.setting), "SPYRIA_SECRETS_KEY")
    error_message = "Set secrets live in Secret Manager; unset optional ones are left out"
  }
  assert {
    condition     = startswith(output.setup_link, "https://spyria.example.com/?setup=")
    error_message = "The setup link carries the setup token"
  }
  assert {
    condition     = one([for container in google_cloud_run_v2_service.server.template[0].containers : container if container.name == "zero-cache"]).startup_probe[0].tcp_socket[0].port == 4848 && one([for container in google_cloud_run_v2_service.server.template[0].containers : container if container.name == "zero-cache"]).startup_probe[0].period_seconds * one([for container in google_cloud_run_v2_service.server.template[0].containers : container if container.name == "zero-cache"]).startup_probe[0].failure_threshold == 600
    error_message = "zero-cache gets the 10 minutes Cloud Run allows at most for its first sync before restarting it"
  }
  assert {
    condition     = google_compute_router_nat.main.enable_dynamic_port_allocation && google_compute_router_nat.main.min_ports_per_vm >= 1024
    error_message = "Streamed model calls from the gateway, which leave through Cloud NAT, get enough ports for many at once"
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
  assert {
    condition     = google_compute_managed_ssl_certificate.hostname.name == "spyria-${substr(sha1(var.hostname), 0, 8)}" && google_compute_managed_ssl_certificate.hostname.name != "spyria"
    error_message = "The certificate is named after its hostname, so a new hostname gets a new certificate before the old one is released"
  }
}

run "an_oidc_app_for_accounts_reaches_the_server_with_its_secret_in_secret_manager" {
  command = apply
  variables {
    oidc_issuer        = "https://login.example.com"
    oidc_client_id     = "spyria"
    oidc_client_secret = "oidc-secret"
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret.setting), "SPYRIA_OIDC_CLIENT_SECRET") && module.settings.server_environment.SPYRIA_OIDC_ISSUER == "https://login.example.com" && module.settings.server_environment.SPYRIA_OIDC_CLIENT_ID == "spyria"
    error_message = "The server gets the OIDC app's issuer and client id as settings and its secret from Secret Manager"
  }
}

run "an_oidc_app_takes_its_issuer_client_id_and_secret_together" {
  command = plan
  variables {
    oidc_issuer    = "https://login.example.com"
    oidc_client_id = "spyria"
  }
  expect_failures = [var.oidc_client_secret]
}

run "the_digest_before_a_change" {
  command = apply
  module {
    source = "./"
  }
  variables {
    google_client_id     = "spyria.apps.googleusercontent.com"
    google_client_secret = "before-secret"
  }
  override_resource {
    target = module.secrets.random_password.secret
    values = { result = "PinnedSecretValueForTheDigestTest0123456789abcd" }
  }
  override_resource {
    target = module.secrets.random_string.gateway_admin_user
    values = { result = "pinnedus" }
  }
  override_resource {
    target = module.secrets.random_string.install_host_token
    values = { result = "ABCDEFGHJKMNPQRS" }
  }
}

run "every_service_carries_a_digest_of_its_secret_values_so_a_changed_secret_restarts_it" {
  command = apply
  module {
    source = "../control-plane"
  }
  override_resource {
    target = module.secrets.random_password.secret
    values = { result = "PinnedSecretValueForTheDigestTest0123456789abcd" }
  }
  override_resource {
    target = module.secrets.random_string.gateway_admin_user
    values = { result = "pinnedus" }
  }
  override_resource {
    target = module.secrets.random_string.install_host_token
    values = { result = "ABCDEFGHJKMNPQRS" }
  }
  variables {
    google_client_id     = "spyria.apps.googleusercontent.com"
    google_client_secret = "rotated-secret"
  }
  assert {
    condition = alltrue([for container in google_cloud_run_v2_service.server.template[0].containers :
    contains([for env in container.env : env.value if env.name == "SPYRIA_SECRETS_DIGEST"], output.secrets_digest)])
    error_message = "Every container carries the new digest, so the platform restarts it with the changed secret"
  }
}

run "a_changed_secret_value_changes_the_digest" {
  command = apply
  module {
    source = "../../shared/tests/two-values"
  }
  variables {
    before = run.the_digest_before_a_change.secrets_digest
    after  = run.every_service_carries_a_digest_of_its_secret_values_so_a_changed_secret_restarts_it.secrets_digest
  }
  assert {
    condition     = var.before != var.after
    error_message = "A changed secret value changes the digest every service carries"
  }
}

run "the_same_values_applied_again" {
  command = apply
  module {
    source = "../../gcp/control-plane"
  }
  variables {
    google_client_id     = "spyria.apps.googleusercontent.com"
    google_client_secret = "before-secret"
  }
  override_resource {
    target = module.secrets.random_password.secret
    values = { result = "PinnedSecretValueForTheDigestTest0123456789abcd" }
  }
  override_resource {
    target = module.secrets.random_string.gateway_admin_user
    values = { result = "pinnedus" }
  }
  override_resource {
    target = module.secrets.random_string.install_host_token
    values = { result = "ABCDEFGHJKMNPQRS" }
  }
}

run "the_same_secret_values_give_the_same_digest" {
  command = apply
  module {
    source = "../../shared/tests/two-values"
  }
  variables {
    before = run.the_digest_before_a_change.secrets_digest
    after  = run.the_same_values_applied_again.secrets_digest
  }
  assert {
    condition     = var.before == var.after
    error_message = "The digest depends on the secret values alone, so an apply that changes no secret restarts nothing"
  }
}

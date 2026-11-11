locals {
  secret_values = merge(
    module.settings.server_secrets,
    module.settings.zero_secrets,
    module.settings.gateway_secrets,
  )
  optional_secrets = {
    SPYRIA_GOOGLE_CLIENT_SECRET    = var.google_client_secret
    SPYRIA_MICROSOFT_CLIENT_SECRET = var.microsoft_client_secret
    SPYRIA_OIDC_CLIENT_SECRET      = var.oidc_client_secret
  }
  unset_secrets = [for name, value in local.optional_secrets : name if nonsensitive(value == "")]
  secret_names  = setsubtract(nonsensitive(keys(local.secret_values)), local.unset_secrets)
  secret_id_of  = { for name in local.secret_names : name => "${var.name}-${lower(replace(name, "_", "-"))}" }
  service_secret_names = {
    server    = setintersection(local.secret_names, nonsensitive(keys(module.settings.server_secrets)))
    zero      = setintersection(local.secret_names, nonsensitive(keys(module.settings.zero_secrets)))
    gateway   = [for name in nonsensitive(keys(module.settings.gateway_secrets)) : name if name != "PGPASSWORD"]
    configure = ["BIFROST_DB_PASSWORD", "DATABASE_URL"]
  }
}

resource "google_secret_manager_secret" "setting" {
  for_each  = local.secret_names
  project   = var.project
  secret_id = local.secret_id_of[each.key]
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}

resource "google_secret_manager_secret_version" "setting" {
  for_each    = local.secret_names
  secret      = google_secret_manager_secret.setting[each.key].id
  secret_data = local.secret_values[each.key]
}

resource "google_service_account" "services" {
  project      = var.project
  account_id   = "${var.name}-services"
  display_name = "Spyria services"
  depends_on   = [google_project_service.api]
}

resource "google_secret_manager_secret_iam_member" "services_read" {
  for_each  = local.secret_names
  project   = var.project
  secret_id = google_secret_manager_secret.setting[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.services.email}"
}

resource "google_compute_global_address" "public" {
  project    = var.project
  name       = var.name
  depends_on = [google_project_service.api]
}

resource "google_compute_managed_ssl_certificate" "hostname" {
  project = var.project
  name    = var.name
  managed {
    domains = [var.hostname]
  }
}

resource "google_compute_region_network_endpoint_group" "server" {
  project               = var.project
  name                  = "${var.name}-server"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.server.name
  }
}

resource "google_compute_backend_service" "server" {
  project               = var.project
  name                  = "${var.name}-server"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend {
    group = google_compute_region_network_endpoint_group.server.id
  }
}

resource "google_compute_url_map" "https" {
  project         = var.project
  name            = var.name
  default_service = google_compute_backend_service.server.id
}

resource "google_compute_target_https_proxy" "https" {
  project          = var.project
  name             = var.name
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.hostname.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project
  name                  = "${var.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.public.address
  port_range            = "443"
  target                = google_compute_target_https_proxy.https.id
}

resource "google_compute_url_map" "redirect" {
  project = var.project
  name    = "${var.name}-redirect"
  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project
  name    = "${var.name}-redirect"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project
  name                  = "${var.name}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.public.address
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
}

data "google_dns_managed_zone" "hostname" {
  count   = var.dns_zone_name == "" ? 0 : 1
  project = var.project
  name    = var.dns_zone_name
}

resource "google_dns_record_set" "hostname" {
  count        = var.dns_zone_name == "" ? 0 : 1
  project      = var.project
  managed_zone = data.google_dns_managed_zone.hostname[0].name
  name         = "${var.hostname}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.public.address]
}

output "origin_url" {
  description = "Where Spyria answers"
  value       = module.settings.origin_url
}

output "setup_link" {
  description = "Opens the creation of the first workspace, once"
  sensitive   = true
  value       = module.settings.setup_link
}

output "install_host_token" {
  description = "One-time code that pairs a runtime host with the first workspace: pass install_host_claim_url to the runtime-host module"
  sensitive   = true
  value       = module.secrets.values.install_host_token
}

output "install_host_claim_url" {
  sensitive = true
  value     = module.settings.install_host_claim_url
}

output "host_image" {
  value = module.settings.host_image
}

output "dns_records" {
  description = "Record to create when the hostname is not in a Cloud DNS zone given to the module; the managed certificate is issued once it resolves"
  value       = var.dns_zone_name == "" ? [{ name = var.hostname, type = "A", value = google_compute_global_address.public.address }] : []
}

output "runtime_host_subnet_id" {
  description = "A subnetwork for runtime hosts, which reaches the internet through Cloud NAT and, unlike the services' subnetwork, not Google's private access to Cloud Run"
  value       = google_compute_subnetwork.hosts.id
  depends_on  = [google_compute_router_nat.main]
}

output "secrets_digest" {
  description = "Changes whenever a secret value changes; every service carries it, so applying a changed secret restarts them"
  value       = local.secrets_digest.SPYRIA_SECRETS_DIGEST
}

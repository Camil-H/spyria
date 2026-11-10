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
  description = "Records to create when the hostname is not in a Route 53 zone given to the module"
  value       = local.manages_dns ? [] : [{ name = var.hostname, type = "CNAME", value = aws_lb.main.dns_name }]
}

output "runtime_host_subnet_id" {
  description = "A public subnet of the control plane's network, for the runtime-host module"
  value       = aws_subnet.public[0].id
  depends_on  = [aws_route_table_association.public]
}

output "secrets_digest" {
  description = "Changes whenever a secret value changes; every service carries it, so applying a changed secret restarts them"
  value       = local.secrets_digest.SPYRIA_SECRETS_DIGEST
}

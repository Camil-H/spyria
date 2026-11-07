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
  description = "Records to create when the hostname is not in an Azure DNS zone given to the module"
  value = local.manages_dns ? [] : [
    { name = var.hostname, type = "CNAME", value = azurerm_container_app.server.ingress[0].fqdn },
    { name = "asuid.${var.hostname}", type = "TXT", value = nonsensitive(azurerm_container_app.server.custom_domain_verification_id) },
  ]
}

output "runtime_host_subnet_id" {
  description = "A subnet of the control plane's network, for the runtime-host module"
  value       = azurerm_subnet.hosts.id
}

output "certificate_command" {
  description = "Run once the hostname is bound: it creates the managed certificate and serves the hostname over HTTPS (the provider cannot bind a managed certificate itself)"
  value       = var.binds_hostname ? "az containerapp hostname bind --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_container_app.server.name} --environment ${azurerm_container_app_environment.main.name} --hostname ${var.hostname} --validation-method CNAME" : ""
}

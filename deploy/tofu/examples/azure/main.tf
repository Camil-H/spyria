terraform {
  required_version = ">= 1.8"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

variable "subscription_id" { type = string }
variable "location" {
  type    = string
  default = "westeurope"
}
variable "hostname" { type = string }
variable "spyria_version" { type = string }
variable "dns_zone_name" {
  type    = string
  default = ""
}
variable "dns_zone_resource_group" {
  type    = string
  default = ""
}
variable "binds_hostname" {
  type    = bool
  default = true
}
variable "oidc_issuer" {
  type    = string
  default = ""
}
variable "oidc_client_id" {
  type    = string
  default = ""
}
variable "oidc_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}
variable "secret_admin_object_ids" {
  type    = list(string)
  default = []
}
variable "size" {
  type    = string
  default = "small"
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

module "control_plane" {
  source                  = "../../modules/azure/control-plane"
  hostname                = var.hostname
  spyria_version          = var.spyria_version
  location                = var.location
  dns_zone_name           = var.dns_zone_name
  dns_zone_resource_group = var.dns_zone_resource_group
  binds_hostname          = var.binds_hostname
  oidc_issuer             = var.oidc_issuer
  oidc_client_id          = var.oidc_client_id
  oidc_client_secret      = var.oidc_client_secret
  secret_admin_object_ids = var.secret_admin_object_ids
  size                    = var.size
}

module "runtime_host" {
  source              = "../../modules/azure/runtime-host"
  claim_url           = module.control_plane.install_host_claim_url
  host_image          = module.control_plane.host_image
  subnet_id           = module.control_plane.runtime_host_subnet_id
  resource_group_name = module.control_plane.resource_group_name
  location            = var.location
  size                = var.size
}

output "origin_url" { value = module.control_plane.origin_url }
output "dns_records" { value = module.control_plane.dns_records }
output "certificate_command" { value = module.control_plane.certificate_command }
output "setup_link" {
  value     = module.control_plane.setup_link
  sensitive = true
}
output "runtime_host_access_command" { value = module.runtime_host.host_access_command }

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
variable "join_by" {
  type    = string
  default = "domain"
}
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
variable "smtp_url" {
  type      = string
  default   = ""
  sensitive = true
}
variable "mail_from" {
  type    = string
  default = ""
}
variable "sign_in_app_client_id" {
  type    = string
  default = ""
}
variable "sign_in_app_client_secret" {
  type      = string
  default   = ""
  sensitive = true
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
  source                    = "../../modules/azure/control-plane"
  hostname                  = var.hostname
  spyria_version            = var.spyria_version
  join_by                   = var.join_by
  location                  = var.location
  dns_zone_name             = var.dns_zone_name
  dns_zone_resource_group   = var.dns_zone_resource_group
  binds_hostname            = var.binds_hostname
  smtp_url                  = var.smtp_url
  mail_from                 = var.mail_from
  sign_in_app_client_id     = var.sign_in_app_client_id
  sign_in_app_client_secret = var.sign_in_app_client_secret
  size                      = var.size
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

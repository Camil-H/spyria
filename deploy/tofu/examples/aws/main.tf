terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "eu-west-1"
}
variable "hostname" { type = string }
variable "spyria_version" { type = string }
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "certificate_arn" {
  type    = string
  default = ""
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
variable "size" {
  type    = string
  default = "small"
}

provider "aws" {
  region = var.region
}

module "control_plane" {
  source             = "../../modules/aws/control-plane"
  hostname           = var.hostname
  spyria_version     = var.spyria_version
  route53_zone_id    = var.route53_zone_id
  certificate_arn    = var.certificate_arn
  oidc_issuer        = var.oidc_issuer
  oidc_client_id     = var.oidc_client_id
  oidc_client_secret = var.oidc_client_secret
  size               = var.size
}

module "runtime_host" {
  source     = "../../modules/aws/runtime-host"
  claim_url  = module.control_plane.install_host_claim_url
  host_image = module.control_plane.host_image
  subnet_id  = module.control_plane.runtime_host_subnet_id
  size       = var.size
}

output "origin_url" { value = module.control_plane.origin_url }
output "dns_records" { value = module.control_plane.dns_records }
output "setup_link" {
  value     = module.control_plane.setup_link
  sensitive = true
}
output "runtime_host_access_command" { value = module.runtime_host.host_access_command }

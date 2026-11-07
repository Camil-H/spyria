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
variable "join_by" {
  type    = string
  default = "domain"
}
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "certificate_arn" {
  type    = string
  default = ""
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
variable "size" {
  type    = string
  default = "small"
}

provider "aws" {
  region = var.region
}

module "control_plane" {
  source          = "../../modules/aws/control-plane"
  hostname        = var.hostname
  spyria_version  = var.spyria_version
  join_by         = var.join_by
  route53_zone_id = var.route53_zone_id
  certificate_arn = var.certificate_arn
  smtp_url        = var.smtp_url
  mail_from       = var.mail_from
  size            = var.size
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

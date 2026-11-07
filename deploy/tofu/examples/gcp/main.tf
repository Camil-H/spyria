terraform {
  required_version = ">= 1.8"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

variable "project" { type = string }
variable "region" {
  type    = string
  default = "europe-west1"
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

provider "google" {
  project = var.project
  region  = var.region
}

module "control_plane" {
  source         = "../../modules/gcp/control-plane"
  project        = var.project
  region         = var.region
  hostname       = var.hostname
  spyria_version = var.spyria_version
  join_by        = var.join_by
  dns_zone_name  = var.dns_zone_name
  smtp_url       = var.smtp_url
  mail_from      = var.mail_from
  size           = var.size
}

module "runtime_host" {
  source     = "../../modules/gcp/runtime-host"
  project    = var.project
  zone       = "${var.region}-b"
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

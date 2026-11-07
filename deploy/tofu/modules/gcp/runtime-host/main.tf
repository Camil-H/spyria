terraform {
  required_version = ">= 1.8"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

variable "name" {
  description = "Deployment name, the same as the control plane's"
  type        = string
  default     = "spyria"
}

variable "host_name" {
  description = "Name of this host among the deployment's, for its cloud resources: give each runtime host its own"
  type        = string
  default     = "runtime-host"
}

variable "claim_url" {
  description = "Claim URL of the host: install_host_claim_url of the control plane for the first host, or the URL at the end of an Add runtime host command"
  type        = string
  sensitive   = true
}

variable "host_image" {
  description = "Published spyria-host image of the control plane's version (its host_image output)"
  type        = string
}

variable "size" {
  description = "small, medium or large: about 6, 14 or 30 runtimes at once"
  type        = string
  default     = "small"
  validation {
    condition     = contains(["small", "medium", "large"], var.size)
    error_message = "size is small, medium or large."
  }
}

variable "subnet_id" {
  description = "Subnetwork with a route to the internet through Cloud NAT, for example the runtime_host_subnet_id of the control plane"
  type        = string
}

variable "project" {
  type = string
}

variable "zone" {
  type    = string
  default = "europe-west1-b"
}

locals {
  machine_types = { small = "e2-standard-2", medium = "e2-standard-4", large = "e2-standard-8" }
  user_data = templatefile("${path.module}/../../shared/runtime-host/cloud-init.yaml.tftpl", {
    name       = var.name
    claim_url  = var.claim_url
    host_image = var.host_image
  })
}

resource "google_compute_instance" "host" {
  project      = var.project
  name         = "${var.name}-${var.host_name}"
  zone         = var.zone
  machine_type = local.machine_types[var.size]
  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 100
      type  = "pd-balanced"
    }
  }
  network_interface {
    subnetwork = var.subnet_id
  }
  metadata = {
    user-data              = local.user_data
    block-project-ssh-keys = "true"
  }
  shielded_instance_config {
    enable_secure_boot = true
  }
  lifecycle {
    ignore_changes = [metadata["user-data"], boot_disk[0].initialize_params[0].image]
  }
}

output "instance_id" {
  value = google_compute_instance.host.id
}

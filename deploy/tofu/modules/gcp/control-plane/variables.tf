variable "name" {
  description = "Deployment name: prefixes every resource and the Docker objects of the runtime hosts"
  type        = string
  default     = "spyria"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,16}$", var.name))
    error_message = "The name takes lowercase letters, digits and dashes, from 2 to 17 characters, starting with a letter: some cloud resource names have short limits."
  }
}

variable "hostname" {
  description = "Public hostname of Spyria, for example spyria.example.com"
  type        = string
}

variable "spyria_version" {
  description = "Release of the published images, for example 1.2.0"
  type        = string
}

variable "images" {
  description = "Registry and namespace of the published images"
  type        = string
  default     = "ghcr.io/camil-h"
}

variable "google_client_id" {
  type    = string
  default = ""
}

variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "microsoft_client_id" {
  type    = string
  default = ""
}

variable "microsoft_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "oidc_issuer" {
  description = "Issuer of an OIDC app people sign in to their account with, besides Google and Microsoft"
  type        = string
  default     = ""
}

variable "oidc_client_id" {
  type    = string
  default = ""
}

variable "oidc_client_secret" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = length(toset([var.oidc_issuer == "", var.oidc_client_id == "", nonsensitive(var.oidc_client_secret == "")])) == 1
    error_message = "Set oidc_issuer, oidc_client_id and oidc_client_secret together or not at all: the server refuses to start otherwise."
  }
}

variable "size" {
  description = "small, medium or large: the CPU and memory of the server and zero-cache, and the database's class"
  type        = string
  default     = "small"
  validation {
    condition     = contains(["small", "medium", "large"], var.size)
    error_message = "size is small, medium or large."
  }
}

variable "project" {
  description = "Google Cloud project"
  type        = string
}

variable "region" {
  description = "Google Cloud region"
  type        = string
  default     = "europe-west1"
}

variable "dns_zone_name" {
  description = "Cloud DNS managed zone holding the hostname: the module points the hostname at the load balancer. Leave empty to create the record of the dns_records output yourself"
  type        = string
  default     = ""
}

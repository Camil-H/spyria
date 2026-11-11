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

variable "location" {
  description = "Azure region"
  type        = string
  default     = "westeurope"
}

variable "dns_zone_name" {
  description = "Azure DNS zone holding the hostname, for example example.com: the module creates its records. Leave empty to create the records of the dns_records output yourself"
  type        = string
  default     = ""
}

variable "dns_zone_resource_group" {
  description = "Resource group of dns_zone_name"
  type        = string
  default     = ""
  validation {
    condition     = var.dns_zone_name == "" || var.dns_zone_resource_group != ""
    error_message = "Set dns_zone_resource_group, the resource group of dns_zone_name."
  }
}

variable "binds_hostname" {
  description = "Binds the hostname with a managed certificate. When DNS is outside Azure, apply once with false, create the dns_records, then apply with true"
  type        = bool
  default     = true
}

variable "secret_admin_object_ids" {
  description = "Object ids of every account that applies this configuration, yours included, such as another admin or a CI service principal, which read its Key Vault secrets when they plan; empty grants the account applying alone"
  type        = list(string)
  default     = []
}

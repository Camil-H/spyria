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

variable "route53_zone_id" {
  description = "Route 53 zone holding the hostname: the certificate is validated and the hostname points at the load balancer by itself. Set it or certificate_arn"
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "An issued ACM certificate for the hostname, when the zone is not in Route 53; then create the records of the dns_records output"
  type        = string
  default     = ""
  validation {
    condition     = var.certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:", var.certificate_arn))
    error_message = "certificate_arn is the ARN of an ACM certificate."
  }
}

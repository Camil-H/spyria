variable "name" {
  description = "Deployment name: prefixes every resource and the Docker objects of the runtime hosts"
  type        = string
  default     = "spyria"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "The name takes lowercase letters, digits and dashes, from 2 to 31 characters, starting with a letter."
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

variable "join_by" {
  description = "Who can join the workspaces: domain or invited-address"
  type        = string
  default     = "domain"
  validation {
    condition     = contains(["domain", "invited-address"], var.join_by)
    error_message = "join_by is domain or invited-address."
  }
}

variable "smtp_url" {
  description = "Optional SMTP URL for domain verification links"
  type        = string
  default     = ""
  sensitive   = true
}

variable "mail_from" {
  description = "Sender of the mail, required with smtp_url"
  type        = string
  default     = ""
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

variable "size" {
  description = "small, medium or large: the server's CPU and memory and the database's class"
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

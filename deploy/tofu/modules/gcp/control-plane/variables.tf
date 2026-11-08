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
  validation {
    condition     = nonsensitive(var.smtp_url == "") || var.mail_from != ""
    error_message = "Set mail_from with smtp_url: the server refuses to start with one and not the other."
  }
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

variable "sign_in_app_client_id" {
  description = "When people join by invited address: the client id of the one sign-in app of every workspace, applied when the server starts"
  type        = string
  default     = ""
}

variable "sign_in_app_client_secret" {
  description = "The client secret of that sign-in app"
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = (var.sign_in_app_client_id == "") == nonsensitive(var.sign_in_app_client_secret == "")
    error_message = "Set sign_in_app_client_id and sign_in_app_client_secret together: the server refuses to start with one and not the other."
  }
}

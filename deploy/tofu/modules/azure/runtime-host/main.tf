terraform {
  required_version = ">= 1.8"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    tls     = { source = "hashicorp/tls", version = "~> 4.0" }
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
  description = "Subnet for the host, for example the runtime_host_subnet_id of the control plane"
  type        = string
}

variable "location" {
  type    = string
  default = "westeurope"
}

variable "resource_group_name" {
  description = "Resource group of the host, for example the control plane's (named after the deployment)"
  type        = string
}

locals {
  vm_sizes = { small = "Standard_D2s_v5", medium = "Standard_D4s_v5", large = "Standard_D8s_v5" }
  custom_data = templatefile("${path.module}/../../shared/runtime-host/cloud-init.yaml.tftpl", {
    name       = var.name
    claim_url  = var.claim_url
    host_image = var.host_image
  })
}

resource "tls_private_key" "unused_login" {
  algorithm = "ED25519"
}

resource "azurerm_public_ip" "host" {
  name                = "${var.name}-${var.host_name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_security_group" "host" {
  name                = "${var.name}-${var.host_name}"
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_network_interface" "host" {
  name                = "${var.name}-${var.host_name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.host.id
  }
}

resource "azurerm_network_interface_security_group_association" "host" {
  network_interface_id      = azurerm_network_interface.host.id
  network_security_group_id = azurerm_network_security_group.host.id
}

resource "azurerm_linux_virtual_machine" "host" {
  name                            = "${var.name}-${var.host_name}"
  location                        = var.location
  resource_group_name             = var.resource_group_name
  size                            = local.vm_sizes[var.size]
  admin_username                  = "spyria"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.host.id]
  custom_data                     = base64encode(local.custom_data)
  admin_ssh_key {
    username   = "spyria"
    public_key = tls_private_key.unused_login.public_key_openssh
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 100
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
  lifecycle {
    ignore_changes = [custom_data]
  }
}

output "virtual_machine_id" {
  value = azurerm_linux_virtual_machine.host.id
}

output "host_access_command" {
  description = "Runs the host's update command on it, saved first as update.sh in the current folder"
  value       = "az vm run-command invoke --resource-group ${var.resource_group_name} --name ${azurerm_linux_virtual_machine.host.name} --command-id RunShellScript --scripts @update.sh"
}

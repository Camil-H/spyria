mock_provider "azurerm" {
  mock_resource "azurerm_public_ip" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/publicIPAddresses/spyria-runtime-host" }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/networkSecurityGroups/spyria-runtime-host" }
  }
  mock_resource "azurerm_network_interface" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/networkInterfaces/spyria-runtime-host" }
  }
}

variables {
  claim_url           = "https://spyria.example.com/h/ABCDEFGHJKMNPQRS"
  host_image          = "ghcr.io/camil-h/spyria-host:1.2.0"
  subnet_id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/spyria/providers/Microsoft.Network/virtualNetworks/spyria/subnets/runtime-hosts"
  resource_group_name = "spyria"
}

run "the_host_dials_out_with_its_claim_and_keeps_runtimes_off_the_metadata_endpoint" {
  command = apply
  assert {
    condition     = length(azurerm_network_security_group.host.security_rule) == 0
    error_message = "No rule lets anything reach the host"
  }
  assert {
    condition     = strcontains(base64decode(azurerm_linux_virtual_machine.host.custom_data), "ghcr.io/camil-h/spyria-host:1.2.0 https://spyria.example.com/h/ABCDEFGHJKMNPQRS")
    error_message = "cloud-init starts the published host with its claim URL"
  }
  assert {
    condition     = strcontains(base64decode(azurerm_linux_virtual_machine.host.custom_data), "169.254.0.0/16") && azurerm_linux_virtual_machine.host.disable_password_authentication
    error_message = "Runtimes are kept off the metadata endpoint, and nobody signs in with a password"
  }
}

run "a_second_host_takes_its_own_name" {
  command = apply
  variables {
    host_name = "build-box"
  }
  assert {
    condition     = azurerm_linux_virtual_machine.host.name == "spyria-build-box" && azurerm_public_ip.host.name == "spyria-build-box"
    error_message = "Each runtime host has its own resources"
  }
}

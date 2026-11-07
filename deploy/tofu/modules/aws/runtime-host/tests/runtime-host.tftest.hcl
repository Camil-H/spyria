mock_provider "aws" {
  mock_data "aws_subnet" {
    defaults = { vpc_id = "vpc-1" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-1" }
  }
}

variables {
  claim_url  = "https://spyria.example.com/h/ABCDEFGHJKMNPQRS"
  host_image = "ghcr.io/camil-h/spyria-host:1.2.0"
  subnet_id  = "subnet-1"
}

run "the_host_dials_out_with_its_claim_and_keeps_runtimes_off_the_metadata_endpoint" {
  command = apply
  assert {
    condition     = length(aws_security_group.host.ingress) == 0
    error_message = "Nothing reaches a runtime host"
  }
  assert {
    condition     = aws_instance.host.metadata_options[0].http_tokens == "required" && aws_instance.host.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "Containers cannot read the instance's credentials through the metadata endpoint"
  }
  assert {
    condition     = strcontains(base64decode(aws_instance.host.user_data_base64), "ghcr.io/camil-h/spyria-host:1.2.0 https://spyria.example.com/h/ABCDEFGHJKMNPQRS")
    error_message = "cloud-init starts the published host with its claim URL"
  }
  assert {
    condition     = strcontains(base64decode(aws_instance.host.user_data_base64), "-d \"$range\" -j DROP") && strcontains(base64decode(aws_instance.host.user_data_base64), "169.254.0.0/16")
    error_message = "Runtimes are kept off the metadata endpoint and private ranges"
  }
  assert {
    condition     = strcontains(base64decode(aws_instance.host.user_data_base64), "--cap-drop ALL --security-opt no-new-privileges --read-only")
    error_message = "The host container runs hardened, like the command of Workspace settings"
  }
}

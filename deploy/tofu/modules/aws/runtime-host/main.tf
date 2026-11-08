terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
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
  description = "Subnet with a route to the internet, for example a public subnet of the control plane"
  type        = string
}

locals {
  instance_types = { small = "m7g.large", medium = "m7g.xlarge", large = "m7g.2xlarge" }
  user_data = templatefile("${path.module}/../../shared/runtime-host/cloud-init.yaml.tftpl", {
    name       = var.name
    claim_url  = var.claim_url
    host_image = var.host_image
  })
}

data "aws_partition" "current" {}

data "aws_region" "current" {}

resource "aws_iam_role" "host" {
  name = "${var.name}-${var.host_name}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "session_manager" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name}-${var.host_name}"
  role = aws_iam_role.host.name
}

data "aws_subnet" "selected" {
  id = var.subnet_id
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720108477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
}

resource "aws_security_group" "host" {
  name        = "${var.name}-${var.host_name}"
  description = "The runtime host dials out to Spyria; nothing reaches it"
  vpc_id      = data.aws_subnet.selected.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "host" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = local.instance_types[var.size]
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true
  user_data_base64            = base64encode(local.user_data)
  user_data_replace_on_change = false
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size = 100
    volume_type = "gp3"
    encrypted   = true
  }
  tags = { Name = "${var.name}-${var.host_name}" }
  lifecycle {
    ignore_changes = [ami, user_data_base64]
  }
}

output "instance_id" {
  value = aws_instance.host.id
}

output "host_access_command" {
  description = "Opens a shell on the host through Session Manager, where the host's update command runs with sudo"
  value       = "aws ssm start-session --region ${data.aws_region.current.region} --target ${aws_instance.host.id}"
}

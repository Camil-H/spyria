resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.zones[count.index]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 10 + count.index)
  tags              = { Name = "${var.name}-database-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "load_balancer" {
  name   = "${var.name}-load-balancer"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  for_each = toset(["server", "zero-cache", "gateway"])
  name     = "${var.name}-${each.key}"
  vpc_id   = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

locals {
  service_ingress = {
    server_from_load_balancer = { to = "server", port = 3000, from = aws_security_group.load_balancer.id }
    server_from_zero          = { to = "server", port = 3000, from = aws_security_group.service["zero-cache"].id }
    zero_from_server          = { to = "zero-cache", port = 4848, from = aws_security_group.service["server"].id }
    gateway_from_server       = { to = "gateway", port = 8080, from = aws_security_group.service["server"].id }
  }
}

resource "aws_vpc_security_group_ingress_rule" "service" {
  for_each                     = local.service_ingress
  security_group_id            = aws_security_group.service[each.value.to].id
  referenced_security_group_id = each.value.from
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "database" {
  name   = "${var.name}-database"
  vpc_id = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  for_each                     = aws_security_group.service
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

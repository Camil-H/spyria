locals {
  secret_values = merge(
    module.settings.server_secrets,
    module.settings.zero_secrets,
    module.settings.gateway_secrets,
  )
  secret_names = toset(nonsensitive(keys(local.secret_values)))
  log_options = {
    awslogs-group         = aws_cloudwatch_log_group.services.name
    awslogs-region        = data.aws_region.current.region
    awslogs-stream-prefix = var.name
  }
  environment_of = { for service, environment in {
    server  = module.settings.server_environment
    zero    = module.settings.zero_environment
    gateway = module.settings.gateway_environment
  } : service => [for name, value in environment : { name = name, value = value }] }
  secrets_of = { for service, names in {
    migrate        = ["DATABASE_URL"]
    server         = nonsensitive(keys(module.settings.server_secrets))
    zero           = nonsensitive(keys(module.settings.zero_secrets))
    gateway        = [for name in nonsensitive(keys(module.settings.gateway_secrets)) : name if name != "PGPASSWORD"]
    gateway_config = ["BIFROST_DB_PASSWORD", "PGPASSWORD"]
  } : service => [for name in names : { name = name, valueFrom = "${aws_secretsmanager_secret.settings.arn}:${name}::" }] }
}

resource "aws_secretsmanager_secret" "settings" {
  name                    = "${var.name}/settings"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "settings" {
  secret_id     = aws_secretsmanager_secret.settings.id
  secret_string = jsonencode(local.secret_values)
}

resource "aws_cloudwatch_log_group" "services" {
  name              = "/${var.name}/services"
  retention_in_days = 30
}

data "aws_iam_policy_document" "tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_settings" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.settings.arn]
  }
}

resource "aws_iam_role_policy" "read_settings" {
  name   = "read-settings"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_settings.json
}

resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = local.namespace
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "service" {
  for_each = toset(["server", "zero-cache", "gateway"])
  name     = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_efs_file_system" "replica" {
  encrypted = true
  tags      = { Name = "${var.name}-zero-replica" }
}

resource "aws_efs_mount_target" "replica" {
  count           = 2
  file_system_id  = aws_efs_file_system.replica.id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.replica_storage.id]
}

resource "aws_ecs_task_definition" "server" {
  family                   = "${var.name}-server"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.size.cpu
  memory                   = local.size.memory
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([
    {
      name             = "migrate"
      image            = module.settings.server_image
      essential        = false
      command          = module.settings.migrate_command
      secrets          = local.secrets_of.migrate
      logConfiguration = { logDriver = "awslogs", options = local.log_options }
    },
    {
      name             = "server"
      image            = module.settings.server_image
      essential        = true
      portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
      environment      = local.environment_of.server
      secrets          = local.secrets_of.server
      dependsOn        = [{ containerName = "migrate", condition = "SUCCESS" }]
      stopTimeout      = 30
      logConfiguration = { logDriver = "awslogs", options = local.log_options }
      healthCheck = {
        command     = ["CMD", "bun", "-e", "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
        interval    = 10
        retries     = 6
        startPeriod = 90
      }
    },
  ])
}

resource "aws_ecs_task_definition" "zero" {
  family                   = "${var.name}-zero-cache"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  volume {
    name = "replica"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.replica.id
      transit_encryption = "ENABLED"
    }
  }
  container_definitions = jsonencode([
    {
      name             = "zero-cache"
      image            = module.settings.zero_image
      essential        = true
      portMappings     = [{ containerPort = 4848, protocol = "tcp" }]
      environment      = local.environment_of.zero
      secrets          = local.secrets_of.zero
      mountPoints      = [{ sourceVolume = "replica", containerPath = "/data" }]
      logConfiguration = { logDriver = "awslogs", options = local.log_options }
    },
  ])
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  volume {
    name = "gateway-data"
  }
  container_definitions = jsonencode([
    {
      name             = "configure"
      image            = module.settings.postgres_client_image
      essential        = false
      entryPoint       = []
      command          = module.settings.gateway_config_command
      environment      = local.environment_of.gateway
      secrets          = local.secrets_of.gateway_config
      mountPoints      = [{ sourceVolume = "gateway-data", containerPath = "/app/data" }]
      logConfiguration = { logDriver = "awslogs", options = local.log_options }
    },
    {
      name             = "gateway"
      image            = module.settings.gateway_image
      essential        = true
      portMappings     = [{ containerPort = 8080, protocol = "tcp" }]
      environment      = local.environment_of.gateway
      secrets          = local.secrets_of.gateway
      dependsOn        = [{ containerName = "configure", condition = "SUCCESS" }]
      mountPoints      = [{ sourceVolume = "gateway-data", containerPath = "/app/data" }]
      logConfiguration = { logDriver = "awslogs", options = local.log_options }
    },
  ])
}

locals {
  ecs_services = {
    server     = { task = aws_ecs_task_definition.server.arn, registry = "server" }
    zero-cache = { task = aws_ecs_task_definition.zero.arn, registry = "zero-cache" }
    gateway    = { task = aws_ecs_task_definition.gateway.arn, registry = "gateway" }
  }
}

resource "aws_ecs_service" "service" {
  for_each                           = local.ecs_services
  name                               = each.key
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = each.value.task
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = each.key == "server" ? 120 : null
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.service[each.key].id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.service[each.value.registry].arn
  }
  dynamic "load_balancer" {
    for_each = each.key == "server" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.server.arn
      container_name   = "server"
      container_port   = 3000
    }
  }
  depends_on = [aws_lb_listener.https, aws_efs_mount_target.replica, aws_secretsmanager_secret_version.settings]
}

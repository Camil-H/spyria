mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_db_instance" {
    defaults = { address = "spyria.abc.eu-west-1.rds.amazonaws.com", port = 5432 }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:spyria/settings-abc" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:eu-west-1:123456789012:certificate/abc", domain_validation_options = [] }
  }
  mock_resource "aws_lb" {
    defaults = { dns_name = "spyria-123.eu-west-1.elb.amazonaws.com", zone_id = "ZLB", arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/spyria/abc" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/spyria-server/abc" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/spyria-task-execution" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:eu-west-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-west-1:123456789012:task-definition/spyria:1" }
  }
}

variables {
  hostname        = "spyria.example.com"
  spyria_version  = "1.2.0"
  route53_zone_id = "Z0123456789"
}

run "the_control_plane_runs_one_server_behind_the_load_balancer_and_keeps_the_rest_internal" {
  command = apply

  assert {
    condition     = output.origin_url == "https://spyria.example.com"
    error_message = "The origin is the hostname over HTTPS"
  }
  assert {
    condition     = startswith(output.setup_link, "https://spyria.example.com/?setup=") && length(output.setup_link) > 70
    error_message = "The setup link carries the setup token"
  }
  assert {
    condition     = can(regex("^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$", output.install_host_token))
    error_message = "The install code has the claim code alphabet the server accepts"
  }
  assert {
    condition     = output.install_host_claim_url == "https://spyria.example.com/h/${output.install_host_token}"
    error_message = "The claim URL of a runtime host names the install code"
  }
  assert {
    condition     = alltrue([for service in aws_ecs_service.service : service.desired_count == 1 && service.deployment_maximum_percent == 100])
    error_message = "Each service runs exactly one task, never two at once"
  }
  assert {
    condition     = length(aws_ecs_service.service["server"].load_balancer) == 1 && length(aws_ecs_service.service["gateway"].load_balancer) == 0 && length(aws_ecs_service.service["zero-cache"].load_balancer) == 0
    error_message = "Only the server is behind the load balancer: the gateway and zero-cache are reachable inside the network alone"
  }
  assert {
    condition     = aws_lb.main.idle_timeout == 3600
    error_message = "Long-lived WebSockets need the load balancer to keep idle connections for an hour"
  }
  assert {
    condition     = one([for parameter in aws_db_parameter_group.postgres.parameter : parameter.value if parameter.name == "rds.logical_replication"]) == "1"
    error_message = "zero-cache needs logical replication"
  }
  assert {
    condition     = aws_db_instance.postgres.engine_version == "18" && aws_db_instance.postgres.deletion_protection
    error_message = "Postgres 18, protected from deletion"
  }
  assert {
    condition = alltrue([for definition in [aws_ecs_task_definition.server, aws_ecs_task_definition.zero, aws_ecs_task_definition.gateway] :
    !strcontains(definition.container_definitions, module.secrets.values.secrets_key) && !strcontains(definition.container_definitions, module.secrets.values.database_password)])
    error_message = "Secrets reach the tasks from Secrets Manager, never in a task definition"
  }
  assert {
    condition     = strcontains(aws_ecs_task_definition.server.container_definitions, "\"condition\":\"SUCCESS\"") && strcontains(aws_ecs_task_definition.server.container_definitions, "\"migrate\"")
    error_message = "The server starts only once its migrations succeeded"
  }
  assert {
    condition     = strcontains(aws_ecs_task_definition.server.container_definitions, "ghcr.io/camil-h/spyria-server:1.2.0")
    error_message = "The server runs the published image of the version"
  }
  assert {
    condition     = aws_route53_record.hostname[0].name == "spyria.example.com" && length(output.dns_records) == 0
    error_message = "With a Route 53 zone the module points the hostname itself"
  }
}

run "without_a_zone_it_takes_an_issued_certificate_and_names_the_record_to_create" {
  command = apply
  variables {
    route53_zone_id = ""
    certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/issued"
  }
  assert {
    condition     = aws_lb_listener.https.certificate_arn == "arn:aws:acm:eu-west-1:123456789012:certificate/issued"
    error_message = "The listener serves the given certificate"
  }
  assert {
    condition     = length(output.dns_records) == 1 && output.dns_records[0].name == "spyria.example.com" && output.dns_records[0].type == "CNAME" && output.dns_records[0].value == "spyria-123.eu-west-1.elb.amazonaws.com"
    error_message = "The hostname must point at the load balancer"
  }
}

run "without_a_zone_or_a_certificate_it_refuses" {
  command = plan
  variables {
    route53_zone_id = ""
  }
  expect_failures = [aws_lb_listener.https]
}

run "it_refuses_an_unknown_join_setting_and_a_bad_name" {
  command = plan
  variables {
    join_by = "anyone"
    name    = "Spyria Prod"
  }
  expect_failures = [var.join_by, var.name]
}

resource "aws_lb" "main" {
  name               = var.name
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.load_balancer.id]
  idle_timeout       = 3600
}

resource "aws_lb_target_group" "server" {
  name                 = "${var.name}-server"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path    = "/health/live"
    matcher = "200"
  }
}

resource "aws_acm_certificate" "main" {
  count             = local.manages_dns ? 1 : 0
  domain_name       = var.hostname
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = local.manages_dns ? {
    for option in aws_acm_certificate.main[0].domain_validation_options : option.domain_name => option
  } : {}
  zone_id = var.route53_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "main" {
  count                   = local.manages_dns ? 1 : 0
  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_route53_record" "hostname" {
  count   = local.manages_dns ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.hostname
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = false
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.manages_dns ? aws_acm_certificate_validation.main[0].certificate_arn : var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.server.arn
  }
  lifecycle {
    precondition {
      condition     = local.manages_dns || var.certificate_arn != ""
      error_message = "Set route53_zone_id, or certificate_arn with an issued ACM certificate for the hostname."
    }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

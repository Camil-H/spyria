resource "aws_db_subnet_group" "postgres" {
  name       = var.name
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${var.name}-postgres18"
  family = "postgres18"
  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "max_slot_wal_keep_size"
    value        = "10240"
    apply_method = "immediate"
  }
}

resource "aws_db_instance" "postgres" {
  identifier                = var.name
  engine                    = "postgres"
  engine_version            = "18"
  instance_class            = local.size.database_class
  allocated_storage         = 20
  max_allocated_storage     = 200
  storage_encrypted         = true
  db_name                   = "spyria"
  username                  = "spyria"
  password                  = module.secrets.values.database_password
  db_subnet_group_name      = aws_db_subnet_group.postgres.name
  parameter_group_name      = aws_db_parameter_group.postgres.name
  vpc_security_group_ids    = [aws_security_group.database.id]
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"
  apply_immediately         = true
}

# Install on AWS

## What you need

- [OpenTofu](https://opentofu.org/docs/intro/install/).
- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), 2.32 or later. Setup signs you in with it when you are not: `aws sso login` when your profile uses IAM Identity Center, `aws login` otherwise.
- `AdministratorAccess`, or `PowerUserAccess` with `IAMFullAccess`, since the module creates IAM roles.
- A Route 53 zone for the hostname, or an issued ACM certificate for it in the chosen region.

## Run the installer

```sh
curl -fsSL https://spyria.dev/install | SPYRIA_SKIP_SETUP=1 sh
spyria setup --cloud aws
```

Setup asks for:

1. The hostname, such as `spyria.example.com`, and the size: `small`, `medium` or `large` (about 6, 14 or 30 runtimes at once).
2. The AWS region (default `eu-west-1`).
3. The Route 53 zone id of the hostname, or, without one, the ARN of an issued ACM certificate for it.

It writes `~/spyria-aws/main.tf` and `terraform.tfvars` (readable by you only), runs `tofu init` and `tofu apply`, then prints the DNS records to create, if any, and the setup link.

Every question is also a flag (`spyria --help`): `--hostname`, `--size`, `--region`, `--route53-zone-id`, `--certificate-arn`, `--version` and `--folder`. `--unattended` asks no question and applies without confirmation.

The folder also holds the OpenTofu state, which contains the deployment's passwords and keys: keep it private and backed up. To keep the state elsewhere, such as in an encrypted S3 bucket, declare that backend in a file of its own like `backend.tf`, since setup rewrites `main.tf` on every run.

## After setup

1. Create the printed DNS records, if any.
2. Open the setup link and create the first workspace.

## Upgrades

- `spyria setup --cloud aws --version <new version>` upgrades the control plane and keeps every other answer.
- Running `spyria setup --cloud aws` again uses the folder's `terraform.tfvars` as defaults (`-` removes an optional answer) and applies the changes, keeping your own variables there.

### Updating runtime host VMs

Upgrades never replace runtime host VMs; they keep their pairing and runtimes. They show **Update available** in Workspace settings, with the command that updates them in place. The hosts accept no inbound traffic: open a shell with the `runtime_host_access_command` setup prints (`aws ssm start-session`, which needs the AWS CLI's Session Manager plugin), run `sudo -i`, then paste the command.

## What it runs

- **Server:** ECS Fargate, one task, migrations in an init container.
- **HTTPS:** an Application Load Balancer with an ACM certificate, and a 1-hour idle timeout.
- **zero-cache and gateway:** Fargate tasks reached through Cloud Map, never public.
- **Postgres:** RDS Postgres 18 in private subnets, with deletion protection.
- **Secrets:** Secrets Manager.
- **Runtime host:** an EC2 (Graviton) VM, IMDSv2 with a hop limit of 1. Its runtimes cannot reach the metadata endpoint or private ranges.
- **zero-cache replica:** 40 GiB at every size, with no limit on its first sync ([sizing](./cloud.md#good-to-know)).

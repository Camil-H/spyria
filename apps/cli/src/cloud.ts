import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import awsExample from '../../../deploy/tofu/examples/aws/main.tf' with { type: 'text' }
import azureExample from '../../../deploy/tofu/examples/azure/main.tf' with { type: 'text' }
import gcpExample from '../../../deploy/tofu/examples/gcp/main.tf' with { type: 'text' }
import { installFolderOf } from './commands.ts'
import { askerOf, type Flags } from './flags.ts'
import { cliVersion, latestVersion, repository } from './release.ts'

export const clouds = ['aws', 'azure', 'gcp'] as const
export type Cloud = (typeof clouds)[number]
type TfVariables = Record<string, string | boolean>

const examples: Record<Cloud, string> = { aws: awsExample, azure: azureExample, gcp: gcpExample }
const signInChecks: Record<Cloud, { command: string[]; hint: string }> = {
  aws: { command: ['aws', 'sts', 'get-caller-identity'], hint: 'sign in with aws configure or aws sso login' },
  azure: { command: ['az', 'account', 'show'], hint: 'sign in with az login' },
  gcp: {
    command: ['gcloud', 'auth', 'application-default', 'print-access-token'],
    hint: 'sign in with gcloud auth application-default login',
  },
}

export const rootModuleOf = (cloud: Cloud, version: string) =>
  examples[cloud].replace(
    /source(\s*)= "\.\.\/\.\.\/modules\/([^"]+)"/g,
    (_, spacing, module) =>
      `source${spacing}= "github.com/${repository}//deploy/tofu/modules/${module}?ref=v${version}"`,
  )

const hclStringOf = (value: string) =>
  JSON.stringify(value)
    .replaceAll('${', () => '$${')
    .replaceAll('%{', () => '%%{')

export const tfVariablesOf = (variables: TfVariables) =>
  Object.entries(variables)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name} = ${typeof value === 'boolean' ? value : hclStringOf(value)}\n`)
    .join('')

const cloudVariablesOf = (cloud: Cloud, asker: ReturnType<typeof askerOf>): TfVariables => {
  if (cloud === 'aws')
    return {
      region: asker.ask('region', 'AWS region', 'eu-west-1'),
      route53_zone_id: asker.ask('route53-zone-id', 'Route 53 zone id of the hostname (empty to give a certificate)'),
      certificate_arn: asker.ask(
        'certificate-arn',
        'ARN of an issued ACM certificate for the hostname (when no Route 53 zone)',
      ),
    }
  if (cloud === 'azure') {
    const dnsZone = asker.ask(
      'dns-zone',
      'Azure DNS zone of the hostname, for example example.com (empty when DNS is elsewhere)',
    )
    return {
      subscription_id: asker.require('subscription', 'Azure subscription id'),
      location: asker.ask('region', 'Azure region', 'westeurope'),
      dns_zone_name: dnsZone,
      dns_zone_resource_group: dnsZone
        ? asker.require('dns-zone-resource-group', 'Resource group of that DNS zone')
        : '',
      binds_hostname: dnsZone !== '' || asker.given('bind-hostname'),
    }
  }
  return {
    project: asker.require('project', 'Google Cloud project id'),
    region: asker.ask('region', 'Google Cloud region', 'europe-west1'),
    dns_zone_name: asker.ask('dns-zone', 'Cloud DNS managed zone name of the hostname (empty when DNS is elsewhere)'),
  }
}

const run = (folder: string, command: string[]) =>
  Bun.spawnSync(command, { cwd: folder, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exitCode

export const setupCloud = async (flags: Flags, cloud: Cloud) => {
  const isUnattended = flags.switches.has('unattended')
  const asker = askerOf(flags, isUnattended)
  const folder = installFolderOf({
    ...flags,
    values: {
      ...flags.values,
      folder: asker.ask('folder', 'Folder of the OpenTofu configuration', `~/spyria-${cloud}`),
    },
  })
  mkdirSync(folder, { recursive: true })
  const version = flags.values.version ?? (cliVersion === 'dev' ? await latestVersion() : cliVersion)
  const smtpUrl = asker.ask('smtp-url', 'SMTP URL for verification links (empty to skip)')
  const variables: TfVariables = {
    hostname: asker.require('hostname', 'Hostname of Spyria, for example spyria.example.com').toLowerCase(),
    spyria_version: version,
    join_by: asker.choose('join-by', 'Who can join', ['domain', 'invited-address'], 'domain'),
    size: asker.choose('size', 'Size', ['small', 'medium', 'large'], 'small'),
    smtp_url: smtpUrl,
    mail_from: smtpUrl ? asker.require('mail-from', 'Sender, for example Spyria <spyria@example.com>') : '',
    ...cloudVariablesOf(cloud, asker),
  }
  writeFileSync(join(folder, 'main.tf'), rootModuleOf(cloud, version))
  writeFileSync(join(folder, 'terraform.tfvars'), tfVariablesOf(variables), { mode: 0o600 })
  chmodSync(join(folder, 'terraform.tfvars'), 0o600)
  console.log(`Wrote ${folder}: main.tf (modules of Spyria ${version}) and terraform.tfvars (readable by you only).`)
  if (flags.switches.has('no-start')) return
  if (Bun.which('tofu') === null)
    throw new Error('OpenTofu is missing: install it (https://opentofu.org/docs/intro/install/), then run this again')
  const signIn = signInChecks[cloud]
  if (
    Bun.which(signIn.command[0] ?? '') === null ||
    Bun.spawnSync(signIn.command, { stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0
  )
    throw new Error(`OpenTofu uses the ${cloud} command line's login: ${signIn.hint}, then run this again`)
  if (run(folder, ['tofu', 'init', '-input=false']) !== 0) throw new Error('tofu init failed')
  if (run(folder, ['tofu', 'apply', '-input=false', ...(isUnattended ? ['-auto-approve'] : [])]) !== 0)
    throw new Error(
      'tofu apply failed: fix the cause shown above and run spyria setup again; it picks up where it stopped',
    )
  const outputs = JSON.parse(
    Bun.spawnSync(['tofu', 'output', '-json'], { cwd: folder, stdout: 'pipe' }).stdout.toString() || '{}',
  ) as Record<string, { value: unknown }>
  const records = (outputs.dns_records?.value ?? []) as { name: string; type: string; value: string }[]
  console.log(
    [
      '',
      `Spyria ${version} runs at ${outputs.origin_url?.value}.`,
      ...(records.length > 0
        ? [
            'Create these DNS records first:',
            ...records.map((record) => `  ${record.name} ${record.type} ${record.value}`),
          ]
        : []),
      ...(cloud === 'azure' && outputs.certificate_command?.value
        ? [`Then serve it over HTTPS with: ${outputs.certificate_command.value}`]
        : []),
      ...(cloud === 'azure' && !variables.binds_hostname
        ? [
            'Once the records exist, run spyria setup --cloud azure again with the same answers and --bind-hostname yes.',
          ]
        : []),
      `Create the first workspace from this setup link, which works once: ${outputs.setup_link?.value}`,
      'A runtime host VM pairs with it when you create it.',
    ].join('\n'),
  )
}

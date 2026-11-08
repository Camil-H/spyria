import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import awsExample from '../../../deploy/tofu/examples/aws/main.tf' with { type: 'text' }
import azureExample from '../../../deploy/tofu/examples/azure/main.tf' with { type: 'text' }
import gcpExample from '../../../deploy/tofu/examples/gcp/main.tf' with { type: 'text' }
import { installFolderOf } from './commands.ts'
import { askerOf, type Flags, type ProcessEnvironment } from './flags.ts'
import { cliVersion, latestVersion, repository } from './release.ts'
import { removal } from './setup-steps.ts'

export const clouds = ['aws', 'azure', 'gcp'] as const
export type Cloud = (typeof clouds)[number]
type TfVariables = Record<string, string | boolean | number>

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
    .map(([name, value]) => `${name} = ${typeof value === 'string' ? hclStringOf(value) : value}\n`)
    .join('')

const isBlankOrComment = (text: string) => /^\s*((#|\/\/).*)?$/.test(text)

const hclStringFrom = (value: string) => {
  let end = 1
  while (end < value.length && value[end] !== '"') end += value[end] === '\\' ? 2 : 1
  if (!isBlankOrComment(value.slice(end + 1))) return undefined
  try {
    return (JSON.parse(value.slice(0, end + 1)) as string).replaceAll('$${', () => '${').replaceAll('%%{', () => '%{')
  } catch {
    return undefined
  }
}

const tfValueFrom = (value: string) => {
  const [, literal = '', rest = ''] = /^(true|false|-?\d+(?:\.\d+)?)(.*)$/.exec(value) ?? []
  if (literal && isBlankOrComment(rest))
    return literal === 'true' || literal === 'false' ? literal === 'true' : Number(literal)
  return value.startsWith('"') ? hclStringFrom(value) : undefined
}

export const tfVariablesFrom = (text: string): TfVariables =>
  Object.fromEntries(
    text.split(/\r?\n/).flatMap((line, index): [string, string | boolean | number][] => {
      if (isBlankOrComment(line)) return []
      const [, name = '', value = ''] = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(line) ?? []
      const parsed = name ? tfValueFrom(value) : undefined
      if (parsed === undefined)
        throw new Error(
          `Line ${index + 1} of terraform.tfvars is not a text, number, true or false on one line: fix it, then run this again`,
        )
      return [[name, parsed]]
    }),
  )

const stringOf = (value: string | boolean | number | undefined) => (typeof value === 'string' ? value : '')

const optionalAnswerOf =
  (asker: ReturnType<typeof askerOf>, existing: TfVariables) =>
  (flag: string, variable: string, question: string, whenEmpty: string, { isSecret = false } = {}) => {
    const saved = stringOf(existing[variable])
    const answer = isSecret
      ? asker.secret(
          flag,
          saved ? `${question} (empty keeps the saved one, ${removal} removes it)` : `${question} (${whenEmpty})`,
          saved,
        )
      : saved
        ? asker.ask(flag, `${question} (${removal} removes it)`, saved)
        : asker.ask(flag, `${question} (${whenEmpty})`)
    return answer === removal ? '' : answer
  }
const joinBys = ['domain', 'invited-address'] as const
const sizes = ['small', 'medium', 'large'] as const
const choiceOf = <Choice extends string>(choices: readonly [Choice, ...Choice[]], previous: string) =>
  choices.find((choice) => choice === previous) ?? choices[0]

const cloudVariablesOf = (cloud: Cloud, asker: ReturnType<typeof askerOf>, existing: TfVariables): TfVariables => {
  const was = (name: string) => stringOf(existing[name])
  const optional = optionalAnswerOf(asker, existing)
  if (cloud === 'aws')
    return {
      region: asker.ask('region', 'AWS region', was('region') || 'eu-west-1'),
      route53_zone_id: optional(
        'route53-zone-id',
        'route53_zone_id',
        'Route 53 zone id of the hostname',
        'empty to give a certificate',
      ),
      certificate_arn: optional(
        'certificate-arn',
        'certificate_arn',
        'ARN of an issued ACM certificate for the hostname',
        'when no Route 53 zone',
      ),
    }
  if (cloud === 'azure') {
    const dnsZone = optional(
      'dns-zone',
      'dns_zone_name',
      'Azure DNS zone of the hostname, for example example.com',
      'empty when DNS is elsewhere',
    )
    return {
      subscription_id: asker.require('subscription', 'Azure subscription id', was('subscription_id')),
      location: asker.ask('region', 'Azure region', was('location') || 'westeurope'),
      dns_zone_name: dnsZone,
      dns_zone_resource_group: dnsZone
        ? asker.require('dns-zone-resource-group', 'Resource group of that DNS zone', was('dns_zone_resource_group'))
        : '',
      binds_hostname:
        dnsZone !== '' ||
        (asker.given('bind-hostname')
          ? asker.choose('bind-hostname', 'Bind the hostname', ['yes', 'no'], 'yes') === 'yes'
          : existing.binds_hostname === true && was('dns_zone_name') === ''),
    }
  }
  return {
    project: asker.require('project', 'Google Cloud project id', was('project')),
    region: asker.ask('region', 'Google Cloud region', was('region') || 'europe-west1'),
    dns_zone_name: optional(
      'dns-zone',
      'dns_zone_name',
      'Cloud DNS managed zone name of the hostname',
      'empty when DNS is elsewhere',
    ),
  }
}

const markerFile = '.spyria-cloud'

const markedCloudOf = (folder: string): Cloud | 'unknown' | undefined => {
  const marker = join(folder, markerFile)
  if (!existsSync(marker)) return undefined
  const named = statSync(marker).isFile() ? readFileSync(marker, 'utf8').trim() : ''
  return clouds.find((candidate) => candidate === named) ?? 'unknown'
}

const assertFolderFor = (folder: string, cloud: Cloud) => {
  if (!existsSync(folder)) return
  if (!statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder: pass --folder with a folder`)
  const markedCloud = markedCloudOf(folder)
  if (markedCloud === 'unknown')
    throw new Error(
      `${join(folder, markerFile)} names no cloud: remove it, or pass --folder with a new or empty folder`,
    )
  if (markedCloud === undefined && readdirSync(folder).length > 0)
    throw new Error(`${folder} was not made by spyria setup --cloud: pass --folder with a new or empty folder`)
  if (markedCloud !== undefined && markedCloud !== cloud)
    throw new Error(`${folder} holds Spyria on ${markedCloud}: pass --folder with a folder for ${cloud}`)
}

export const hostUpdateStepsOf = (cloud: Cloud, accessCommand: string) =>
  cloud === 'azure'
    ? `When Spyria asks you to update that host, save the update command it shows as update.sh, then run, from that folder: ${accessCommand}`
    : `When Spyria asks you to update that host, open a shell on it with ${accessCommand}${cloud === 'aws' ? ' (it needs the Session Manager plugin of the AWS CLI)' : ''}, run sudo -i, then paste the update command it shows.`

const run = (folder: string, command: string[]) =>
  Bun.spawnSync(command, { cwd: folder, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exitCode

export const setupCloud = async (
  flags: Flags,
  cloud: Cloud,
  { environment = process.env }: { environment?: ProcessEnvironment } = {},
) => {
  const isUnattended = flags.switches.has('unattended')
  const asker = askerOf(flags, isUnattended, environment)
  const folder = installFolderOf({
    ...flags,
    values: {
      ...flags.values,
      folder: asker.ask(
        'folder',
        'Folder of the OpenTofu configuration',
        markedCloudOf(process.cwd()) === cloud ? process.cwd() : `~/spyria-${cloud}`,
      ),
    },
  })
  assertFolderFor(folder, cloud)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  chmodSync(folder, 0o700)
  const variablesFile = join(folder, 'terraform.tfvars')
  const existing = existsSync(variablesFile) ? tfVariablesFrom(readFileSync(variablesFile, 'utf8')) : {}
  const was = (name: string) => stringOf(existing[name])
  if (Object.keys(existing).length > 0) console.log(`Setting up ${folder} again: its answers are the defaults.`)
  const version =
    flags.values.version || was('spyria_version') || (cliVersion === 'dev' ? await latestVersion() : cliVersion)
  const smtpUrl = optionalAnswerOf(asker, existing)(
    'smtp-url',
    'smtp_url',
    'SMTP URL for verification links',
    'empty to skip',
    { isSecret: true },
  )
  const variables: TfVariables = {
    ...existing,
    hostname: asker
      .require('hostname', 'Hostname of Spyria, for example spyria.example.com', was('hostname'))
      .toLowerCase(),
    spyria_version: version,
    join_by: asker.choose('join-by', 'Who can join', joinBys, choiceOf(joinBys, was('join_by'))),
    size: asker.choose('size', 'Size', sizes, choiceOf(sizes, was('size'))),
    smtp_url: smtpUrl,
    mail_from: smtpUrl
      ? asker.require('mail-from', 'Sender, for example Spyria <spyria@example.com>', was('mail_from'))
      : '',
    ...cloudVariablesOf(cloud, asker, existing),
  }
  writeFileSync(join(folder, markerFile), `${cloud}\n`)
  writeFileSync(join(folder, 'main.tf'), rootModuleOf(cloud, version))
  writeFileSync(variablesFile, tfVariablesOf(variables), { mode: 0o600 })
  chmodSync(variablesFile, 0o600)
  console.log(
    `Wrote ${folder}, readable by you only, since the OpenTofu state it will hold carries every secret: main.tf (modules of Spyria ${version}) and terraform.tfvars.`,
  )
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
        ? ['Once the records exist, run spyria setup --cloud azure again with --bind-hostname yes.']
        : []),
      `Create the first workspace from this setup link, which works once: ${outputs.setup_link?.value}`,
      'A runtime host VM pairs with it when you create it.',
      ...(outputs.runtime_host_access_command?.value
        ? [hostUpdateStepsOf(cloud, String(outputs.runtime_host_access_command.value))]
        : []),
    ].join('\n'),
  )
}

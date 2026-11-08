import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostUpdateStepsOf, rootModuleOf, setupCloud, tfVariablesFrom, tfVariablesOf } from './cloud.ts'
import { parseFlags } from './flags.ts'

const folder = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

test('the root module uses the modules of the chosen release from GitHub', () => {
  const module = rootModuleOf('aws', '1.2.0')
  expect(module).toMatch(
    /source +=\s"github\.com\/Camil-H\/spyria\/\/deploy\/tofu\/modules\/aws\/control-plane\?ref=v1\.2\.0"/,
  )
  expect(module).toMatch(
    /source +=\s"github\.com\/Camil-H\/spyria\/\/deploy\/tofu\/modules\/aws\/runtime-host\?ref=v1\.2\.0"/,
  )
  expect(module).not.toContain('../../modules')
})

test('variables are written as HCL, quoted safely, empty ones left out', () => {
  const interpolations = ['smtps://u:p$', '{x}%{y}@smtp.example.com'].join('')
  expect(tfVariablesOf({ smtp_url: interpolations })).toBe(
    ['smtp_url = "smtps://u:p$$', '{x}%%{y}@smtp.example.com"\n'].join(''),
  )
  expect(
    tfVariablesOf({
      hostname: 'spyria.example.com',
      mail_from: 'Spyria "Team" <s@example.com>',
      smtp_url: '',
      binds_hostname: false,
    }),
  ).toBe('hostname = "spyria.example.com"\nmail_from = "Spyria \\"Team\\" <s@example.com>"\nbinds_hostname = false\n')
})

test('spyria setup --cloud writes the configuration and private variables of the cloud from the answers', async () => {
  await setupCloud(
    parseFlags([
      ...['setup', '--cloud', 'gcp', '--unattended', '--no-start', '--folder', folder, '--version', '1.2.0'],
      ...['--hostname', 'Spyria.Example.com', '--project', 'acme-prod', '--join-by', 'invited-address'],
    ]),
    'gcp',
    { environment: {} },
  )
  expect(readFileSync(join(folder, 'main.tf'), 'utf8')).toContain('deploy/tofu/modules/gcp/control-plane?ref=v1.2.0')
  expect(readFileSync(join(folder, 'terraform.tfvars'), 'utf8')).toBe(
    [
      'hostname = "spyria.example.com"',
      'spyria_version = "1.2.0"',
      'join_by = "invited-address"',
      'size = "small"',
      'project = "acme-prod"',
      'region = "europe-west1"',
      '',
    ].join('\n'),
  )
  expect(statSync(join(folder, 'terraform.tfvars')).mode & 0o777).toBe(0o600)
})

test('the variables file reads back to the answers it was written from', () => {
  const answers = {
    smtp_url: ['smtps://u:p$', '{x}%{y}@smtp.example.com'].join(''),
    mail_from: 'Spyria "Team" <s@example.com>',
    binds_hostname: true,
    dns_zone_name: 'example.com',
  }
  expect(tfVariablesFrom(tfVariablesOf(answers))).toEqual(answers)
})

test('spyria setup --cloud run again with only a new version upgrades and keeps every other answer', async () => {
  const setupGcp = (extra: string[], environment = {}) =>
    setupCloud(
      parseFlags(['setup', '--cloud', 'gcp', '--unattended', '--no-start', '--folder', folder, ...extra]),
      'gcp',
      { environment },
    )
  await setupGcp(
    [
      ...['--version', '1.2.0', '--hostname', 'spyria.example.com', '--project', 'acme-prod'],
      ...['--join-by', 'invited-address', '--size', 'medium', '--region', 'europe-north1', '--dns-zone', 'example'],
      ...['--mail-from', 'Spyria <spyria@example.com>'],
    ],
    { SPYRIA_SETUP_SMTP_URL: 'smtps://u:p@smtp.example.com' },
  )
  const before = tfVariablesFrom(readFileSync(join(folder, 'terraform.tfvars'), 'utf8'))
  await setupGcp(['--version', '1.3.0'])
  expect(tfVariablesFrom(readFileSync(join(folder, 'terraform.tfvars'), 'utf8'))).toEqual({
    ...before,
    spyria_version: '1.3.0',
  })
  expect(readFileSync(join(folder, 'main.tf'), 'utf8')).toContain('deploy/tofu/modules/gcp/control-plane?ref=v1.3.0')
})

test('the variables file is read after tofu fmt aligned it, with comments, and keeps variables setup does not ask', () => {
  const formatted = [
    '# Spyria on GCP',
    'hostname       = "spyria.example.com" # the public name',
    'spyria_version = "1.2.0"',
    'binds_hostname = false',
    'runtime_hosts  = 2',
    '',
  ].join('\n')
  expect(tfVariablesFrom(formatted)).toEqual({
    hostname: 'spyria.example.com',
    spyria_version: '1.2.0',
    binds_hostname: false,
    runtime_hosts: 2,
  })
  const unreadable = () => tfVariablesFrom('hostname = "a"\nsmtp_url = <<EOT\nsmtps://u:secret@x\nEOT\n')
  expect(unreadable).toThrow(
    'Line 2 of terraform.tfvars is not a text, number, true or false, or list of texts on one line: fix it, then run this again',
  )
})

test('run again by hand, a saved SMTP URL is never shown, empty keeps an answer and - removes it', async () => {
  const azureFolder = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
  const questions: string[] = []
  const answersByQuestion: [string, string][] = []
  const originalPrompt = globalThis.prompt
  globalThis.prompt = (question?: string) => {
    questions.push(question ?? '')
    return answersByQuestion.find(([start]) => question?.startsWith(start))?.[1] ?? ''
  }
  try {
    const setupAzure = (extra: string[] = [], environment = {}) =>
      setupCloud(parseFlags(['setup', '--cloud', 'azure', '--no-start', '--folder', azureFolder, ...extra]), 'azure', {
        environment,
      })
    await setupAzure(
      [
        ...['--version', '1.2.0', '--hostname', 'spyria.example.com', '--subscription', 'subscription-1'],
        ...[
          '--mail-from',
          'Spyria <spyria@example.com>',
          '--dns-zone',
          'example.com',
          '--dns-zone-resource-group',
          'dns',
        ],
      ],
      { SPYRIA_SETUP_SMTP_URL: 'smtps://u:secret@smtp.example.com' },
    )
    const saved = () => tfVariablesFrom(readFileSync(join(azureFolder, 'terraform.tfvars'), 'utf8'))
    expect(saved()).toMatchObject({ dns_zone_name: 'example.com', binds_hostname: true })

    await setupAzure()
    expect(questions.join('\n')).not.toContain('secret')
    expect(questions).toContain('SMTP URL for verification links (empty keeps the saved one, - removes it)')
    expect(saved()).toMatchObject({ smtp_url: 'smtps://u:secret@smtp.example.com', dns_zone_name: 'example.com' })

    answersByQuestion.push(['SMTP URL', '-'], ['Azure DNS zone', '-'])
    await setupAzure()
    const removed = saved()
    expect(removed.smtp_url).toBeUndefined()
    expect(removed.mail_from).toBeUndefined()
    expect(removed.dns_zone_name).toBeUndefined()
    expect(removed.dns_zone_resource_group).toBeUndefined()
    expect(removed.binds_hostname).toBe(false)
    expect(removed.hostname).toBe('spyria.example.com')
  } finally {
    globalThis.prompt = originalPrompt
    rmSync(azureFolder, { recursive: true, force: true })
  }
})

test('the variables file is read with Windows line endings and names with dashes', () => {
  expect(tfVariablesFrom('# saved on Windows\r\nhostname = "spyria.example.com"\r\nmy-own_name = "kept"\r\n')).toEqual({
    hostname: 'spyria.example.com',
    'my-own_name': 'kept',
  })
})

test('- never becomes an answer, even with nothing saved, and --bind-hostname takes yes or no only', async () => {
  const freshFolder = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
  try {
    const setupAzure = (extra: string[], environment = {}) =>
      setupCloud(
        parseFlags([
          ...['setup', '--cloud', 'azure', '--unattended', '--no-start', '--folder', freshFolder, '--version', '1.2.0'],
          ...['--hostname', 'spyria.example.com', '--subscription', 'subscription-1', ...extra],
        ]),
        'azure',
        { environment },
      )
    const saved = () => tfVariablesFrom(readFileSync(join(freshFolder, 'terraform.tfvars'), 'utf8'))
    await setupAzure(['--dns-zone', '-', '--bind-hostname', 'no'], { SPYRIA_SETUP_SMTP_URL: '-' })
    expect(saved().dns_zone_name).toBeUndefined()
    expect(saved().smtp_url).toBeUndefined()
    expect(saved().binds_hostname).toBe(false)
    await setupAzure(['--bind-hostname', 'yes'])
    expect(saved().binds_hostname).toBe(true)
    expect(await setupAzure(['--bind-hostname', 'false']).catch((error: Error) => error.message)).toBe(
      '--bind-hostname must be yes or no',
    )
  } finally {
    rmSync(freshFolder, { recursive: true, force: true })
  }
})

test('run from inside a cloud configuration without --folder, setup --cloud keeps using that folder', async () => {
  const originalDirectory = process.cwd()
  try {
    process.chdir(folder)
    await setupCloud(
      parseFlags(['setup', '--cloud', 'gcp', '--unattended', '--no-start', '--version', '1.4.0']),
      'gcp',
      {
        environment: {},
      },
    )
    expect(tfVariablesFrom(readFileSync(join(folder, 'terraform.tfvars'), 'utf8')).spyria_version).toBe('1.4.0')
  } finally {
    process.chdir(originalDirectory)
  }
})

test('the configuration folder, where OpenTofu keeps its state with every secret, is readable by its owner only', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
  try {
    const existing = join(parent, 'existing')
    const created = join(parent, 'created')
    mkdirSync(existing)
    chmodSync(existing, 0o755)
    for (const target of [existing, created]) {
      await setupCloud(
        parseFlags([
          ...['setup', '--cloud', 'gcp', '--unattended', '--no-start', '--folder', target, '--version', '1.2.0'],
          ...['--hostname', 'spyria.example.com', '--project', 'acme-prod'],
        ]),
        'gcp',
        { environment: {} },
      )
      expect(statSync(target).mode & 0o777).toBe(0o700)
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('setup --cloud marks the folders it makes, and writes only into a new or empty folder or one it marked for the same cloud', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
  try {
    const setupIn = (target: string, cloud: 'gcp' | 'aws' = 'gcp') =>
      setupCloud(
        parseFlags([
          ...['setup', '--cloud', cloud, '--unattended', '--no-start', '--folder', target, '--version', '1.2.0'],
          ...['--hostname', 'spyria.example.com', '--project', 'acme-prod', '--certificate-arn', 'arn:aws:acm:x'],
        ]),
        cloud,
        { environment: {} },
      ).catch((error: Error) => error.message)

    const onAws = join(parent, 'aws')
    expect(await setupIn(onAws, 'aws')).toBeUndefined()
    expect(readFileSync(join(onAws, '.spyria-cloud'), 'utf8')).toBe('aws\n')
    const awsRootModule = readFileSync(join(onAws, 'main.tf'), 'utf8')
    expect(await setupIn(onAws)).toBe(`${onAws} holds Spyria on aws: pass --folder with a folder for gcp`)
    expect(readFileSync(join(onAws, 'main.tf'), 'utf8')).toBe(awsRootModule)

    for (const [name, files] of [
      ['opentofu-project', { 'network.tofu': 'resource "x" "y" {}\n' }],
      ['spyria-without-marker', { 'main.tf': rootModuleOf('gcp', '1.2.0') }],
      ['anything', { 'notes.txt': 'mine\n' }],
    ] as const) {
      const unmarked = join(parent, name)
      for (const [file, content] of Object.entries(files)) await Bun.write(join(unmarked, file), content)
      expect(await setupIn(unmarked)).toBe(
        `${unmarked} was not made by spyria setup --cloud: pass --folder with a new or empty folder`,
      )
      expect(readdirSync(unmarked).sort()).toEqual(Object.keys(files).sort())
    }

    const abandoned = join(parent, 'abandoned')
    expect(
      await setupCloud(
        parseFlags([
          'setup',
          '--cloud',
          'aws',
          '--unattended',
          '--no-start',
          '--folder',
          abandoned,
          '--version',
          '1.2.0',
        ]),
        'aws',
        { environment: {} },
      ).catch((error: Error) => error.message),
    ).toBe('--hostname is required')
    expect(readdirSync(abandoned)).toEqual([])
    expect(await setupIn(abandoned)).toBeUndefined()

    const garbled = join(parent, 'garbled')
    await Bun.write(join(garbled, '.spyria-cloud'), '\n')
    expect(await setupIn(garbled)).toBe(
      `${join(garbled, '.spyria-cloud')} names no cloud: remove it, or pass --folder with a new or empty folder`,
    )
    const notAFolder = join(parent, 'not-a-folder')
    await Bun.write(notAFolder, 'mine\n')
    expect(await setupIn(notAFolder)).toBe(`${notAFolder} is not a folder: pass --folder with a folder`)

    const empty = join(parent, 'empty')
    mkdirSync(empty)
    expect(await setupIn(empty)).toBeUndefined()
    await Bun.write(join(empty, 'backend.tf.json'), '{"terraform":{"backend":{"gcs":{"bucket":"acme-state"}}}}\n')
    await Bun.write(join(empty, 'terraform.tfstate'), '{}')
    expect(await setupIn(empty)).toBeUndefined()
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the host update steps setup prints name what each cloud needs besides the access command', () => {
  expect(hostUpdateStepsOf('aws', 'aws ssm start-session --region eu-west-1 --target i-1')).toBe(
    'When Spyria asks you to update that host, open a shell on it with aws ssm start-session --region eu-west-1 --target i-1 (it needs the Session Manager plugin of the AWS CLI), run sudo -i, then paste the update command it shows.',
  )
  expect(hostUpdateStepsOf('gcp', 'gcloud compute ssh h --tunnel-through-iap')).toBe(
    'When Spyria asks you to update that host, open a shell on it with gcloud compute ssh h --tunnel-through-iap, run sudo -i, then paste the update command it shows.',
  )
  expect(hostUpdateStepsOf('azure', 'az vm run-command invoke --scripts @update.sh')).toBe(
    'When Spyria asks you to update that host, save the update command it shows as update.sh in the current folder, then run there: az vm run-command invoke --scripts @update.sh',
  )
})

test('a one-line list of texts in terraform.tfvars, such as the Azure secret admins, reads back and survives a run of setup', async () => {
  const answers = { secret_admin_object_ids: ['00000000-0000-0000-0000-0000000000aa', ['odd$', '{x}'].join('')] }
  expect(tfVariablesOf(answers)).toBe(
    'secret_admin_object_ids = ["00000000-0000-0000-0000-0000000000aa", "odd$$' + '{x}"]\n',
  )
  expect(tfVariablesFrom(tfVariablesOf(answers))).toEqual(answers)
  expect(tfVariablesFrom('admins = ["a", "b"] # who applies\n')).toEqual({ admins: ['a', 'b'] })

  const azureFolder = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
  try {
    const setupAzure = () =>
      setupCloud(
        parseFlags([
          ...['setup', '--cloud', 'azure', '--unattended', '--no-start', '--folder', azureFolder, '--version', '1.2.0'],
          ...['--hostname', 'spyria.example.com', '--subscription', 'subscription-1'],
        ]),
        'azure',
        { environment: {} },
      )
    await setupAzure()
    const variablesFile = join(azureFolder, 'terraform.tfvars')
    await Bun.write(variablesFile, `${readFileSync(variablesFile, 'utf8')}secret_admin_object_ids = ["ci-principal"]\n`)
    await setupAzure()
    expect(tfVariablesFrom(readFileSync(variablesFile, 'utf8')).secret_admin_object_ids).toEqual(['ci-principal'])
  } finally {
    rmSync(azureFolder, { recursive: true, force: true })
  }
})

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootModuleOf, setupCloud, tfVariablesOf } from './cloud.ts'
import { parseFlags } from './flags.ts'

const folder = mkdtempSync(join(tmpdir(), 'spyria-cloud-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

test('the root module uses the modules of the chosen release from GitHub', () => {
  const module = rootModuleOf('aws', '1.2.0')
  expect(module).toContain(
    'source          = "github.com/Camil-H/spyria//deploy/tofu/modules/aws/control-plane?ref=v1.2.0"',
  )
  expect(module).toContain('source     = "github.com/Camil-H/spyria//deploy/tofu/modules/aws/runtime-host?ref=v1.2.0"')
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

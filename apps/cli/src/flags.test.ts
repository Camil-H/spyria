import { expect, test } from 'bun:test'
import { askerOf, composeArgumentsOf, parseFlags } from './flags.ts'

test('flags take a value after them or inline, switches stand alone, and the rest are positionals', () => {
  expect(
    parseFlags([
      'restore',
      'backups/x.dump',
      '--keep',
      '3',
      '--hostname=spyria.example.com',
      '--unattended',
      '--no-host',
    ]),
  ).toEqual({
    values: { keep: '3', hostname: 'spyria.example.com' },
    switches: new Set(['unattended', 'no-host']),
    positionals: ['restore', 'backups/x.dump'],
  })
})

test('an unattended run takes flags and defaults, and refuses a missing required answer or an unknown choice', () => {
  const { ask, choose, require } = askerOf(
    parseFlags(['--unattended', '--join-by', 'invited-address', '--name', ' prod ']),
  )
  expect(ask('name', 'Deployment name', 'spyria')).toBe('prod')
  expect(ask('folder', 'Install folder', '~/spyria')).toBe('~/spyria')
  expect(choose('join-by', 'Who can join', ['domain', 'invited-address'], 'domain')).toBe('invited-address')
  expect(() => require('hostname', 'Hostname')).toThrow('--hostname is required')
  const wrong = askerOf(parseFlags(['--unattended', '--join-by', 'anyone']))
  expect(() => wrong.choose('join-by', 'Who can join', ['domain', 'invited-address'], 'domain')).toThrow(
    '--join-by must be domain or invited-address',
  )
})

test('spyria compose passes every argument to Compose except the install folder', () => {
  expect(composeArgumentsOf(['logs', '--tail', '50', '-f', 'server'])).toEqual(['logs', '--tail', '50', '-f', 'server'])
  expect(composeArgumentsOf(['--folder', '/srv/spyria', 'ps'])).toEqual(['ps'])
  expect(composeArgumentsOf(['ps', '--folder=/srv/spyria'])).toEqual(['ps'])
})

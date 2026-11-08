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

test('a secret is never a flag: it comes from its environment variable, or from a question that never shows the saved one', () => {
  expect(() => askerOf(parseFlags(['setup', '--cloudflare-token', 'token']))).toThrow(
    '--cloudflare-token would leave a secret in your shell history and process list: set CLOUDFLARE_API_TOKEN instead',
  )
  const unattended = askerOf(parseFlags(['--unattended']), true, { RESEND_API_KEY: ' re_key ' })
  expect(unattended.secret('resend-key', 'Resend API key')).toBe('re_key')
  expect(unattended.given('resend-key')).toBe(true)
  expect(unattended.secret('google-client-secret', 'Client secret', 'saved-secret')).toBe('saved-secret')
  expect(() => unattended.requireSecret('okta-token', 'Okta API token')).toThrow('OKTA_API_TOKEN is required')

  const questions: string[] = []
  const answers = ['', 'typed-secret']
  const originalPrompt = globalThis.prompt
  globalThis.prompt = (question?: string) => {
    questions.push(question ?? '')
    return answers.shift() ?? ''
  }
  try {
    const interactive = askerOf(parseFlags([]), false, {})
    expect(
      interactive.secret('google-client-secret', 'Client secret (empty keeps the saved one)', 'saved-secret'),
    ).toBe('saved-secret')
    expect(interactive.secret('google-client-secret', 'Client secret', 'saved-secret')).toBe('typed-secret')
  } finally {
    globalThis.prompt = originalPrompt
  }
  expect(questions).toEqual(['Client secret (empty keeps the saved one)', 'Client secret'])
})

import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askerOf, composeArgumentsOf, parseFlags } from './flags.ts'

const work = mkdtempSync(join(tmpdir(), 'spyria-flags-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

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
    '--cloudflare-token would leave a secret in your shell history and process list: set SPYRIA_SETUP_CLOUDFLARE_TOKEN instead',
  )
  const unattended = askerOf(parseFlags(['--unattended']), true, { SPYRIA_SETUP_RESEND_KEY: ' re_key ' })
  expect(unattended.secret('resend-key', 'Resend API key')).toBe('re_key')
  expect(unattended.given('resend-key')).toBe(true)
  expect(unattended.secret('google-client-secret', 'Client secret', 'saved-secret')).toBe('saved-secret')
  expect(() => unattended.requireSecret('okta-token', 'Okta API token')).toThrow('SPYRIA_SETUP_OKTA_TOKEN is required')

  const questions: string[] = []
  const answers = ['', 'typed-secret']
  const interactive = askerOf(parseFlags([]), false, {}, (question) => {
    questions.push(question)
    return answers.shift() ?? ''
  })
  expect(interactive.secret('google-client-secret', 'Client secret (empty keeps the saved one)', 'saved-secret')).toBe(
    'saved-secret',
  )
  expect(interactive.secret('google-client-secret', 'Client secret', 'saved-secret')).toBe('typed-secret')
  expect(questions).toEqual(['Client secret (empty keeps the saved one)', 'Client secret'])
})

test('variables other tools export never answer for setup, and setup names the variable it took a secret from, never the value', () => {
  const elsewhere = askerOf(parseFlags(['--unattended']), true, {
    RESEND_API_KEY: 're_other_project',
    SMTP_URL: 'smtps://other:project@smtp.example.com',
    GOOGLE_CLIENT_SECRET: 'other-project-secret',
  })
  expect(elsewhere.given('resend-key')).toBe(false)
  expect(elsewhere.given('smtp-url')).toBe(false)
  expect(elsewhere.secret('google-client-secret', 'Client secret', 'saved-secret')).toBe('saved-secret')

  const printed: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    const asker = askerOf(parseFlags(['--unattended']), true, { SPYRIA_SETUP_RESEND_KEY: 're_meant_for_spyria' })
    expect(asker.secret('resend-key', 'Resend API key')).toBe('re_meant_for_spyria')
  } finally {
    log.mockRestore()
  }
  expect(printed).toEqual(['Using SPYRIA_SETUP_RESEND_KEY from the environment'])
})

test('a secret typed in a terminal never shows on it, and the terminal echoes again once it is read', async () => {
  const flagsModule = new URL('./flags.ts', import.meta.url).pathname
  const asking = join(work, 'ask-secret.ts')
  writeFileSync(
    asking,
    [
      `import { hiddenAnswerTo } from ${JSON.stringify(flagsModule)}`,
      "const answer = hiddenAnswerTo('Resend API key')",
      "console.log(answer === 'typed-secret' ? 'answered as typed' : 'answered something else')",
      "console.log(Bun.spawnSync(['stty', '-a'], { stdin: 'inherit' }).stdout.toString().includes('-echo ') ? 'echo off' : 'echo on')",
    ].join('\n'),
  )
  const command = [process.execPath, asking]
  const inTerminal =
    process.platform === 'darwin'
      ? ['script', '-q', '/dev/null', ...command]
      : ['script', '-qec', command.join(' '), '/dev/null']
  const terminal = Bun.spawn(inTerminal, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const decoder = new TextDecoder()
  let output = ''
  const reader = terminal.stdout.getReader()
  const readUntil = async (text: string) => {
    while (!output.includes(text)) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value)
    }
  }
  await readUntil('Resend API key')
  terminal.stdin.write('typed-secret\n')
  await terminal.stdin.flush()
  await readUntil('echo o')
  await readUntil('\n')
  terminal.kill()
  expect(output).toContain('answered as typed')
  expect(output).toContain('echo on')
  expect(output).not.toContain('typed-secret')
}, 20_000)

import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDeployment } from './deployment.ts'
import { harnesses, harnessIds, signInCommandOf, signInNoticeOf } from './harnesses.ts'

const claudeConfigSeenAtLaunch = (existingConfig?: string) => {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
  if (existingConfig !== undefined) writeFileSync(join(home, '.claude.json'), existingConfig)
  writeFileSync(join(home, 'claude-agent-acp'), '#!/bin/sh\ncat "$HOME/.claude.json"\n')
  chmodSync(join(home, 'claude-agent-acp'), 0o755)
  const launched = Bun.spawnSync([...harnesses['claude-code'].launch], {
    env: { HOME: home, PATH: `${home}:${process.env.PATH}` },
  })
  expect(launched.exitCode).toBe(0)
  return launched.stdout.toString()
}

test('the registry ids are the keys of the host credentials stores and the agent form shapes, which cannot import it', () => {
  expect(harnessIds).toEqual(['claude-code', 'codex'])
})

test('the sign-in notice names the host login command of the same harness id', () => {
  expect(signInNoticeOf('claude-code', defaultDeployment)).toBe(
    'Sign in to Claude Code on your machine: docker exec -it spyria-host spyria-host login claude-code',
  )
  expect(signInNoticeOf('codex', defaultDeployment)).toEndWith(signInCommandOf('codex', defaultDeployment))
})

test("the sign-in command execs into the deployment's host container", () => {
  expect(signInCommandOf('codex', 'spyria-prod')).toBe('docker exec -it spyria-prod-host spyria-host login codex')
})

test('Claude Code starts with a configuration file in its home, keeping one that exists', () => {
  expect(claudeConfigSeenAtLaunch()).toBe('{}')
  expect(claudeConfigSeenAtLaunch('{"numStartups":3}')).toBe('{"numStartups":3}')
})

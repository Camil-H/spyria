import { expect, test } from 'bun:test'
import { defaultDeployment } from './deployment.ts'
import { harnessIds, signInCommandOf, signInNoticeOf } from './harnesses.ts'

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

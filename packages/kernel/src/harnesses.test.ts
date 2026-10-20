import { expect, test } from 'bun:test'
import { harnessIds, signInCommandOf, signInNoticeOf } from './harnesses.ts'

test('the registry ids are the keys of the host credentials stores and the agent form shapes, which cannot import it', () => {
  expect(harnessIds).toEqual(['claude-code', 'codex'])
})

test('the sign-in notice names the host login command of the same harness id', () => {
  expect(signInNoticeOf('claude-code')).toBe(
    'Sign in to Claude Code on your machine: docker exec -it spyria-host spyria-host login claude-code',
  )
  expect(signInNoticeOf('codex')).toEndWith(signInCommandOf('codex'))
})

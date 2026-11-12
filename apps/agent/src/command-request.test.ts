import { expect, test } from 'bun:test'
import { asksToRunACommand } from './command-request.ts'

test.each([
  'You can manually restore it by running: cp "/home/spyria/.claude/backups/.claude.json.backup.1" "/home/spyria/.claude.json"',
  'Try running `claude doctor`',
  'Please run `codex login` first',
  'Run: `npm install`',
])('"%s" asks to run a command', (line) => {
  expect(asksToRunACommand(line)).toBe(true)
})

test.each([
  'Claude Code process terminated by signal SIGABRT',
  'Invalid API key · Please run /login',
  'Error: connect ENOENT /var/run/docker.sock',
  'Failed to run: ENOENT',
  'The process running the session exited',
])('"%s" does not ask to run a command', (line) => {
  expect(asksToRunACommand(line)).toBe(false)
})

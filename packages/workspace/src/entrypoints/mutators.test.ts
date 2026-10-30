import { expect, test } from 'bun:test'
import { type DevLoopSettings, defaultDevLoopRules, defaultDevLoopSettings } from '@spyria/kernel'
import { devLoopArgument, setupCommandsArgument } from './mutators.ts'

test('the settings the page sends pass the mutators’ argument checks, so only the server rules can refuse them', () => {
  const settings: DevLoopSettings = {
    rules: [
      defaultDevLoopRules,
      {
        repository: 'acme/app',
        isOn: true,
        timeLimitMinutes: 60,
        costLimitMicros: 5_000_000,
        steps: [
          { kind: 'command', name: 'Lint', command: 'bun run lint', timeoutMinutes: 10, fixes: 3 },
          { kind: 'review', fixes: 2 },
          { kind: 'pull_request' },
          { kind: 'ci', fixes: 0 },
        ],
      },
    ],
  }
  expect(devLoopArgument.safeParse(settings)).toMatchObject({ success: true, data: settings })
  expect(devLoopArgument.safeParse(defaultDevLoopSettings).success).toBe(true)
  expect(devLoopArgument.safeParse(null).success).toBe(true)
  const commands = [
    { repository: null, command: 'bun install' },
    { repository: 'acme/app', command: 'bun install && bun run db:migrate' },
  ]
  expect(setupCommandsArgument.safeParse(commands)).toMatchObject({ success: true, data: commands })
})

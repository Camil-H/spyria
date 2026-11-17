import { expect, test } from 'bun:test'
import { failuresSummaryOf, type Suite } from './e2e-summary.ts'

const specOf = (file: string, title: string, status: 'expected' | 'unexpected' | 'flaky' | 'skipped') => ({
  file,
  title,
  tests: [{ projectName: 'e2e', status }],
})

test('failing and flaky tests are listed under their feature folder, features in order, passing and skipped ones left out', () => {
  const report: Suite = {
    suites: [
      {
        specs: [
          specOf('e2e/04-agent/browser.spec.ts', 'As a prompter, I watch the agent browse', 'unexpected'),
          specOf('e2e/04-agent/browser.spec.ts', 'As a prompter, I take over the browser', 'expected'),
        ],
        suites: [{ specs: [specOf('e2e/02-chats/messages.spec.ts', 'As a member, I edit a message', 'flaky')] }],
      },
      { specs: [specOf('e2e/04-agent/runs.spec.ts', 'As a prompter, I stop a run', 'unexpected')] },
      { specs: [specOf('e2e/08-admin/budgets.spec.ts', 'As an admin, I set a budget', 'skipped')] },
    ],
  }
  expect(failuresSummaryOf('e2e shard 2/4', report)).toBe(
    [
      '### e2e shard 2/4: 3 failing tests',
      '',
      '**02-chats**',
      '',
      '- 02-chats › messages.spec.ts › As a member, I edit a message (flaky: passed on retry)',
      '',
      '**04-agent**',
      '',
      '- 04-agent › browser.spec.ts › As a prompter, I watch the agent browse',
      '- 04-agent › runs.spec.ts › As a prompter, I stop a run',
      '',
    ].join('\n'),
  )
})

test('a failed platform check says the stack is broken rather than a feature', () => {
  const report: Suite = {
    suites: [
      { specs: [specOf('e2e/00-platform/platform.spec.ts', 'the agent stream reaches the browser', 'unexpected')] },
    ],
  }
  expect(failuresSummaryOf('e2e shard 1/4', report)).toContain('the test stack is broken, not a feature')
})

test('a run without a report or without a failing test points to the job log', () => {
  expect(failuresSummaryOf('e2e shard 3/4', undefined)).toContain('Playwright wrote no report')
  expect(failuresSummaryOf('e2e shard 3/4', { suites: [] })).toContain('No test failed')
})

import { expect, test } from 'bun:test'
import { logExcerptOf } from './ci-logs.ts'

const stamped = (lines: string[]) => lines.map((line) => `2026-10-28T20:00:01.1234567Z ${line}`).join('\r\n')

test('a log excerpt keeps the failing step up to its error, without timestamps, colors or group markers', () => {
  expect(
    logExcerptOf(
      stamped([
        '##[group]Run bun install',
        'bun install',
        '##[endgroup]',
        'installed',
        '##[group]Run bun test',
        'bun test',
        'shell: /usr/bin/bash -e {0}',
        '##[endgroup]',
        '\u001b[31m1 fail\u001b[0m',
        '##[error]Process completed with exit code 1.',
        '##[group]Post Run actions/checkout',
        'cleaning up',
        '##[endgroup]',
      ]),
    ),
  ).toBe(
    [
      'Run bun test',
      'bun test',
      'shell: /usr/bin/bash -e {0}',
      '1 fail',
      'error: Process completed with exit code 1.',
    ].join('\n'),
  )
})

test('a log excerpt keeps the last 100 lines of a long step, the end of a log without an error, and cuts long text', () => {
  const long = logExcerptOf(
    stamped(['##[group]Run bun test', ...Array.from({ length: 300 }, (_, i) => `line ${i}`), '##[error]Failed']),
  )
  expect(long.split('\n')).toHaveLength(100)
  expect(long).toStartWith('line 201\n')
  expect(long).toEndWith('\nerror: Failed')
  expect(logExcerptOf(stamped(['a', 'b', ''])).split('\n')).toEqual(['a', 'b'])
  const wide = logExcerptOf(stamped(['##[group]Run x', 'y'.repeat(20_000), '##[error]Failed']))
  expect(wide).toStartWith('[cut]\n')
  expect(wide.length).toBe(10_006)
})

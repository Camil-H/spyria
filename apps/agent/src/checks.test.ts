import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTestbed } from './testing.ts'

const { started } = createAgentTestbed()
const directory = mkdtempSync(join(tmpdir(), 'spyria-agent-checks-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const workspaceWith = (name: string, config?: string) => {
  const workspace = join(directory, name)
  mkdirSync(join(workspace, '.spyria'), { recursive: true })
  if (config !== undefined) writeFileSync(join(workspace, '.spyria/dev-loop.json'), config)
  return workspace
}

const finishedChecks = async (call: ReturnType<typeof started>['call']) => {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(20)) {
    const { body } = await call('GET', '/api/workspace/checks')
    if (body.state === 'finished') return body
  }
  throw new Error('The checks did not finish')
}

test('the checks of .spyria/dev-loop.json run one after the other in the background, each with its exit code and the end of its output, both streams together', async () => {
  const config = JSON.stringify({
    checks: { Lint: 'echo linted', Types: 'echo "src/a.ts: type error" >&2 && exit 2' },
    ci: ['ci-ok'],
  })
  const { call } = started({ workspaceDirectory: workspaceWith('two-checks', config) })
  expect((await call('GET', '/api/workspace/checks')).body).toEqual({ state: 'idle', results: [] })
  const begun = await call('POST', '/api/workspace/checks', {})
  expect(begun).toMatchObject({ status: 200, body: { state: 'running', ci: ['ci-ok'] } })
  expect(await finishedChecks(call)).toEqual({
    state: 'finished',
    ci: ['ci-ok'],
    results: [
      { name: 'Lint', command: 'echo linted', exitCode: 0, output: 'linted' },
      {
        name: 'Types',
        command: 'echo "src/a.ts: type error" >&2 && exit 2',
        exitCode: 2,
        output: 'src/a.ts: type error',
      },
    ],
  })
})

test('starting checks while they run returns the running checks instead of starting them again', async () => {
  const config = JSON.stringify({ checks: { Slow: 'sleep 0.5; echo once >> runs.txt' } })
  const workspace = workspaceWith('running', config)
  const { call } = started({ workspaceDirectory: workspace })
  await call('POST', '/api/workspace/checks', {})
  expect((await call('POST', '/api/workspace/checks', {})).body).toMatchObject({ state: 'running', results: [] })
  await finishedChecks(call)
  expect(await Bun.file(join(workspace, 'runs.txt')).text()).toBe('once\n')
})

test('a check past its time limit is stopped and has no exit code; a repository without the file has no checks', async () => {
  const config = JSON.stringify({ checks: { Stuck: 'echo waiting; sleep 30' } })
  const { call } = started({ workspaceDirectory: workspaceWith('stuck', config), checkTimeoutMilliseconds: 200 })
  await call('POST', '/api/workspace/checks', {})
  expect((await finishedChecks(call)).results).toEqual([
    { name: 'Stuck', command: 'echo waiting; sleep 30', output: 'waiting' },
  ])

  const bare = started({ workspaceDirectory: workspaceWith('no-config') })
  await bare.call('POST', '/api/workspace/checks', {})
  expect(await finishedChecks(bare.call)).toEqual({ state: 'finished', results: [] })
})

test.each([
  ['{', '.spyria/dev-loop.json is not valid: it is not JSON'],
  ['{"checks": ["bun test"]}', '.spyria/dev-loop.json is not valid: "checks" must map each check name to a command'],
  ['{"checks": {"Lint": ""}}', '.spyria/dev-loop.json is not valid: "checks" must map each check name to a command'],
  ['{"ci": "ci-ok"}', '.spyria/dev-loop.json is not valid: "ci" must list the names of the CI checks that count'],
])('an invalid .spyria/dev-loop.json (%s) is refused with the reason', async (config, failure) => {
  const { call } = started({ workspaceDirectory: workspaceWith(`invalid-${Bun.hash(config)}`, config) })
  expect(await call('POST', '/api/workspace/checks', {})).toEqual({ status: 422, body: { error: failure } })
})

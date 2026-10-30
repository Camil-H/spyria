import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTestbed } from './testing.ts'

const { started } = createAgentTestbed()
const directory = mkdtempSync(join(tmpdir(), 'spyria-agent-checks-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const workspaceNamed = (name: string) => {
  const workspace = join(directory, name)
  mkdirSync(workspace, { recursive: true })
  return workspace
}
const check = (name: string, command: string, timeoutMinutes = 5) => ({
  name,
  command,
  timeout_minutes: timeoutMinutes,
})

const finishedChecks = async (call: ReturnType<typeof started>['call']) => {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(20)) {
    const { body } = await call('GET', '/api/workspace/checks')
    if (body.state === 'finished') return body
  }
  throw new Error('The checks did not finish')
}

test('the checks the server sends run one after the other in the background, each with its exit code and the end of its output, both streams together', async () => {
  const { call } = started({ workspaceDirectory: workspaceNamed('two-checks') })
  expect((await call('GET', '/api/workspace/checks')).body).toEqual({ state: 'idle', id: null, results: [] })
  const checks = [check('Lint', 'echo linted'), check('Types', 'echo "src/a.ts: type error" >&2 && exit 2')]
  expect(await call('POST', '/api/workspace/checks', { checks, run_id: 'run-1' })).toMatchObject({
    status: 200,
    body: { state: 'running', id: 'run-1' },
  })
  expect(await finishedChecks(call)).toEqual({
    state: 'finished',
    id: 'run-1',
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
  const workspace = workspaceNamed('running')
  const { call } = started({ workspaceDirectory: workspace })
  const checks = [check('Slow', 'sleep 0.5; echo once >> runs.txt')]
  await call('POST', '/api/workspace/checks', { checks, run_id: 'first' })
  expect((await call('POST', '/api/workspace/checks', { checks, run_id: 'second' })).body).toMatchObject({
    state: 'running',
    id: 'first',
    results: [],
  })
  await finishedChecks(call)
  expect(await Bun.file(join(workspace, 'runs.txt')).text()).toBe('once\n')
})

test.each([
  [{}, 'Give between 1 and 20 checks'],
  [{ checks: [] }, 'Give between 1 and 20 checks'],
  [{ checks: [check('Lint', ' ')] }, 'Each check needs a name, a command and a timeout in minutes'],
  [{ checks: [check('Lint', 'bun run lint', 0)] }, 'Each check needs a name, a command and a timeout in minutes'],
  [{ checks: [check('Lint', 'bun run lint', 121)] }, 'Each check needs a name, a command and a timeout in minutes'],
])('checks %o are refused with the reason', async (body, failure) => {
  const { call } = started({ workspaceDirectory: workspaceNamed(`invalid-${Bun.hash(JSON.stringify(body))}`) })
  expect(await call('POST', '/api/workspace/checks', body)).toEqual({ status: 422, body: { error: failure } })
})

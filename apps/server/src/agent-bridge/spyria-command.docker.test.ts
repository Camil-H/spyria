import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'

setDefaultTimeout(120_000)
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

const calls: string[] = []
const gateway = Bun.serve({
  port: 0,
  hostname: '0.0.0.0',
  fetch: async (request) => {
    const { id, method, params } = await request.json()
    calls.push(`${method} ${request.headers.get('authorization')}`)
    const result =
      method === 'tools/list'
        ? { tools: [{ name: 'crm_ab12cd-lookup', description: 'Reads a record', inputSchema: { type: 'object' } }] }
        : method === 'tools/call'
          ? { content: [{ type: 'text', text: `ran ${params.name}` }] }
          : {}
    return Response.json({ jsonrpc: '2.0', id, result })
  },
})
afterAll(() => gateway.stop(true))

const inImage = async (command: string[], environment: Record<string, string> = {}) => {
  const run = Bun.spawn(
    [
      ...['docker', 'run', '--rm', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL'],
      ...['--add-host', 'host.docker.internal:host-gateway'],
      ...Object.entries(environment).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      ...['--entrypoint', command[0] as string, spyriaImage, ...command.slice(1)],
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()]
  return { exitCode: await run.exited, stdout, stderr }
}

test('in the runtime image, the spyria command lists the connected services and runs a tool through Spyria with the session’s token, and the Pi skill that points to it is there', async () => {
  const session = {
    SPYRIA_TOOLS_URL: `http://host.docker.internal:${gateway.port}/mcp`,
    SPYRIA_MCP_TOKEN: 'runtime-token',
  }
  const listed = await inImage(['spyria'], session)
  expect(listed.stdout).toStartWith('Connected services:\n  crm_ab12cd  1 tool\n')
  const ran = await inImage(['spyria', 'crm', 'lookup'], session)
  expect([ran.exitCode, ran.stdout]).toEqual([0, 'ran crm_ab12cd-lookup\n'])
  expect(calls.filter((call) => call.startsWith('tools/call'))).toEqual(['tools/call Bearer runtime-token'])

  const outside = await inImage(['spyria'])
  expect([outside.exitCode, outside.stderr]).toEqual([1, 'spyria runs only inside a Spyria session\n'])
  expect((await inImage(['cat', '/usr/local/lib/spyria/skills/spyria-tools/SKILL.md'])).stdout).toContain(
    'name: spyria-tools',
  )
})

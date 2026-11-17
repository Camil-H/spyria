import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '@spyria/db/postgres'
import { runtimeHostId } from '@spyria/kernel'
import type { createLlmGateway } from '@spyria/profile/server'
import { websocket } from 'hono/bun'
import { createAgentBridge } from '../agent-bridge/bridge.ts'
import { createApp } from '../app.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import { acme, aliceInAcme, sessionTokenOf, testAuthSettings, testSecretsKeyring, waitFor } from './testing.ts'

const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const runtimeReadyMilliseconds = 30_000
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerObjectKinds = [
  { list: ['ps', '-aq'], remove: ['rm', '-f'] },
  { list: ['volume', 'ls', '-q'], remove: ['volume', 'rm', '-f'] },
  { list: ['network', 'ls', '-q'], remove: ['network', 'rm'] },
]

export const startDockerTestHost = async ({
  database,
  spyriaAgentImage,
  personal = false,
  environment = {},
  llmGateway,
}: {
  database: Database
  spyriaAgentImage: string
  personal?: boolean
  environment?: Record<string, string>
  llmGateway?: ReturnType<typeof createLlmGateway>
}) => {
  const deployment = `spyria-test-${crypto.randomUUID().slice(0, 8)}`
  const prefix = `${deployment}-`
  const stateDirectory = mkdtempSync(join(tmpdir(), 'spyria-test-host-'))
  const gateway = createRuntimeHostGateway({
    secretsKeyring: testSecretsKeyring,
    databases: () => [database],
    spyriaAgentImage,
    relayModelCall: llmGateway && createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
  })
  const agentBridge = createAgentBridge({ sandboxProvider: gateway.sandboxProvider, spyriaAgentImage })
  const app = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts: gateway, agentBridge })
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
  const added = await app.request('/api/runtime-hosts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, acme, aliceInAcme.userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(personal ? { personal: true } : { name: 'Docker test host' }),
  })
  const { id, code } = (await added.json()) as { id: string; code: string }
  const hostId = runtimeHostId(id)
  const hostProcess = Bun.spawn(
    [process.execPath, hostProgram, ...(personal ? ['--personal'] : []), `http://localhost:${server.port}/h/${code}`],
    {
      env: { ...process.env, SPYRIA_HOST_STATE_DIR: stateDirectory, SPYRIA_DEPLOYMENT: deployment, ...environment },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  )
  const hostOutputChunks: string[] = []
  void (async () => {
    for await (const chunk of hostProcess.stdout) {
      hostOutputChunks.push(new TextDecoder().decode(chunk))
      process.stdout.write(chunk)
    }
  })()

  const cleanup = async () => {
    hostProcess.kill()
    await hostProcess.exited
    await agentBridge.release(database)
    for (const { list, remove } of dockerObjectKinds) {
      const names = docker(...list, '--filter', `name=^${prefix}`)
        .stdout.toString()
        .split('\n')
        .filter(Boolean)
      if (names.length > 0) docker(...remove, ...names)
    }
    void server.stop(true)
    rmSync(stateDirectory, { recursive: true, force: true })
  }
  const isOnline = async () =>
    (await database.$client`select status from runtime_hosts where id = ${hostId}`)[0]?.status === 'online'
  await waitFor(isOnline, 30_000).catch(async (error: unknown) => {
    await cleanup()
    throw error
  })

  type Runtime = Parameters<typeof gateway.sandboxProvider.connect>[0]
  const readyRuntime = async (runtime: Runtime) => {
    const transport = gateway.sandboxProvider.connect(runtime)
    const isReady = () =>
      transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
        (response) => response.status === 200,
        () => false,
      )
    for (const deadline = Date.now() + runtimeReadyMilliseconds; !(await isReady()); await Bun.sleep(100))
      if (Date.now() > deadline) throw new Error(`${runtime.runtimeId} was not ready within 30 s`)
    return transport
  }

  return {
    gateway,
    app,
    agentBridge,
    hostId,
    prefix,
    hostOutput: () => hostOutputChunks.join(''),
    readyRuntime,
    cleanup,
  }
}

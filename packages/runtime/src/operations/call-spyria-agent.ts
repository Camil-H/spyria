import type { RuntimeId } from '@spyria/kernel'
import type { SandboxLocation, SandboxProvider, SandboxTransport } from '../contracts/sandbox-provider.ts'
import { type AgentReadiness, readinessOf } from '../domain/agent-version.ts'
import { RuntimeNotReady } from '../domain/errors.ts'

const readyBudgetMilliseconds = 15_000
const readyPollMilliseconds = 250
const requestTimeoutMilliseconds = 30_000
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const readinessProbe = (transport: SandboxTransport) =>
  transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
    (response) => (response.status === 200 ? readinessOf(response.body) : undefined),
    () => undefined,
  )

export const waitUntilReady = async (transport: SandboxTransport, runtimeId: RuntimeId): Promise<AgentReadiness> => {
  for (const deadline = Date.now() + readyBudgetMilliseconds; ; await sleep(readyPollMilliseconds)) {
    const readiness = await readinessProbe(transport)
    if (readiness) return readiness
    if (Date.now() > deadline) throw new RuntimeNotReady(runtimeId)
  }
}

export const callSpyriaAgent = async (
  provider: SandboxProvider,
  sandbox: SandboxLocation & { apiKeyId: string },
  method: string,
  path: string,
  body?: object,
) => {
  const response = await provider.connect(sandbox).fetch({
    method,
    path,
    headers: { 'content-type': 'application/json', 'x-session-api-key': provider.apiKeyOf(sandbox) },
    body: body && JSON.stringify(body),
    timeoutMilliseconds: requestTimeoutMilliseconds,
  })
  if (response.status >= 300) throw new Error(`spyria-agent answered ${method} ${path} with ${response.status}`)
  return JSON.parse(response.body || '{}') as unknown
}

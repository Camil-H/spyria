import { startAgent } from './agent.ts'
import { log, startTelemetry } from './telemetry.ts'

const telemetry = startTelemetry()
const apiKey = process.env.OH_SESSION_API_KEYS_0
delete process.env.OH_SESSION_API_KEYS_0
if (!apiKey) {
  log.error({ event: 'agent.unconfigured', body: 'spyria-agent needs OH_SESSION_API_KEYS_0' })
  await telemetry.shutdown()
  process.exit(2)
}
const agent = startAgent({
  apiKey,
  port: Number(process.env.PORT ?? 8000),
  workspaceDirectory: process.env.SPYRIA_WORKSPACE_DIR,
})
log.info({ event: 'agent.listening', body: 'spyria-agent is listening', attributes: { 'server.port': agent.port } })
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    await agent.stop()
    await telemetry.shutdown()
    process.exit(0)
  })

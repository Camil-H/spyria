import { startAgent } from './agent.ts'

const apiKey = process.env.OH_SESSION_API_KEYS_0
delete process.env.OH_SESSION_API_KEYS_0
if (!apiKey) {
  console.error('spyria-agent needs OH_SESSION_API_KEYS_0')
  process.exit(2)
}
const agent = startAgent({
  apiKey,
  port: Number(process.env.PORT ?? 8000),
  workspaceDirectory: process.env.SPYRIA_WORKSPACE_DIR,
})
console.log(`spyria-agent listening on port ${agent.port}`)
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    await agent.stop()
    process.exit(0)
  })

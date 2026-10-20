import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { rebuildMessages } from '@spyria/conversation/server'
import { createDatabase } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { createLlmGateway, type ToolServerSetup } from '@spyria/profile/server'
import { verifyDomainByOperator } from './auth/sso.ts'
import { listFailedJobs, retryFailedJobs } from './job-worker.ts'

const [command = '', ...options] = process.argv.slice(2)
const database = createDatabase()
const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const optionOf = (name: string) => (options.includes(name) ? options[options.indexOf(name) + 1] : undefined)
const toolServers: Record<string, () => ToolServerSetup> = {
  github: () => ({
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    oauthConfig: {
      client_id: requiredEnvironment('GITHUB_MCP_CLIENT_ID'),
      client_secret: requiredEnvironment('GITHUB_MCP_CLIENT_SECRET'),
      scopes: ['repo', 'read:org', 'read:user'],
    },
  }),
  notion: () => ({ name: 'Notion', url: 'https://mcp.notion.com/mcp' }),
}
const logInAsAdmin = async (authorizeUrl: string) => {
  console.log(`Log in once as the Spyria admin of this server, then press Enter:\n${authorizeUrl}`)
  for await (const _ of console) break
}
const commands: Record<string, () => Promise<void>> = {
  'rebuild-messages': async () => {
    const chatId = options.includes('--chat') ? options[options.indexOf('--chat') + 1] : null
    if (chatId === undefined) throw new Error('Usage: bun run db:rebuild-messages [--chat <id>]')
    const count = await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId }))
    console.log(`Rebuilt ${count} messages${chatId ? ` of chat ${chatId}` : ''} from the events`)
  },
  'failed-jobs': async () => {
    const failedJobs = await listFailedJobs(database)
    if (failedJobs.length === 0) console.log('No failed job')
    else console.table(failedJobs)
  },
  'tools-setup': async () => {
    const [name = ''] = options
    const setup = toolServers[name]
    if (!setup) throw new Error(`Usage: bun run tools:setup ${Object.keys(toolServers).join('|')}`)
    const gateway = createLlmGateway({
      url: process.env.SPYRIA_GATEWAY_URL ?? 'http://127.0.0.1:8180',
      adminUser: process.env.SPYRIA_GATEWAY_ADMIN_USER ?? 'spyria',
      adminPassword: process.env.SPYRIA_GATEWAY_ADMIN_PASSWORD ?? 'spyria-dev-gateway',
    })
    const server = setup()
    const isNew = await gateway.setUpToolServer(server, logInAsAdmin)
    console.log(isNew ? `${server.name} is set up: members can connect it` : `${server.name} was already set up`)
  },
  'sso:verify-domain': async () => {
    const [workspaceId, domain] = ['--workspace', '--domain'].map(optionOf)
    if (!workspaceId || !domain)
      throw new Error('Usage: bun run operator sso:verify-domain --workspace <id> --domain <domain>')
    await verifyDomainByOperator(database, workspaceId, domain)
    console.log(`${domain} is verified for workspace ${workspaceId}`)
  },
  'retry-jobs': async () => {
    const [target] = options
    if (!target) throw new Error('Usage: bun run jobs:retry <id>|--all')
    const jobIds = await retryFailedJobs(database, target === '--all' ? 'all' : target)
    console.log(jobIds.length === 0 ? 'No failed job matched' : `Requeued ${jobIds.join(', ')}`)
  },
}
try {
  await (commands[command] ?? (() => Promise.reject(new Error(`Unknown command ${command}`))))()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await database.$client.end()
}

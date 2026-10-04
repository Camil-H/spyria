import { rebuildMessages } from '@hq/conversation/server'
import { createDatabase } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { listFailedJobs, retryFailedJobs } from './job-worker.ts'

const [command = '', ...options] = process.argv.slice(2)
const database = createDatabase()
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

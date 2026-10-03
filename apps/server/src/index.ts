import { createDatabase } from '@hq/db/postgres'
import { createApp } from './app.ts'

const isDevAuthEnabled = process.env.HQ_DEV_AUTH === '1'
const tokenSecret =
  process.env.HQ_TOKEN_SECRET ?? (isDevAuthEnabled ? `${crypto.randomUUID()}${crypto.randomUUID()}` : undefined)
if (!tokenSecret) throw new Error('HQ_TOKEN_SECRET is required')

const app = createApp({ database: createDatabase(), tokenSecret, isDevAuthEnabled })

export default { port: 3000, hostname: '0.0.0.0', fetch: app.fetch }

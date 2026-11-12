import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { rebuildMessages } from '@spyria/conversation/server'
import { createDatabase } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { createSecretBox, secretsKeyringFrom } from './auth/secret-box.ts'
import { hasNoWorkspace, stopWorkspaceSsoByOperator } from './auth/sso.ts'
import { listFailedJobs, retryFailedJobs } from './job-worker.ts'
import { countRuntimesRunningOnPreviousKeys, resealSecrets } from './reseal-secrets.ts'
import { abandonFailedCleanup, purgeWorkspaceNow, restoreWorkspace } from './workspace-deletion.ts'

const [command = '', ...options] = process.argv.slice(2)
const database = createDatabase()
const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
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
  'has-workspace': async () => {
    console.log((await hasNoWorkspace(database.$client)) ? 'no' : 'yes')
  },
  'setup-link': async () => {
    if (!(await hasNoWorkspace(database.$client)))
      throw new Error('A workspace already exists: the setup link is spent')
    const origin = requiredEnvironment('SPYRIA_APP_ORIGIN')
    console.log(`${origin}/?${new URLSearchParams({ setup: requiredEnvironment('SPYRIA_SETUP_TOKEN') })}`)
  },
  'workspace:stop-sso': async () => {
    const [workspaceId] = options
    if (!workspaceId) throw new Error('Usage: bun run operator workspace:stop-sso <id>')
    const isStopped = await stopWorkspaceSsoByOperator(database, workspaceId)
    console.log(
      isStopped
        ? `Workspace ${workspaceId} no longer enforces SSO: its members sign in with their own accounts`
        : `Workspace ${workspaceId} does not enforce SSO`,
    )
  },
  'secrets:reseal': async () => {
    const keyring = secretsKeyringFrom(process.env)
    const resealedCount = await resealSecrets(database, createSecretBox(keyring))
    console.log(`Sealed ${resealedCount} stored secret${resealedCount === 1 ? '' : 's'} again with SPYRIA_SECRETS_KEY`)
    const runningCount = await countRuntimesRunningOnPreviousKeys(database, keyring.currentKeyId)
    console.log(
      runningCount === 0
        ? 'Nothing uses a previous key any more: SPYRIA_PREVIOUS_SECRETS_KEYS can be removed'
        : `${runningCount} running runtime${runningCount === 1 ? '' : 's'} still use${runningCount === 1 ? 's' : ''} a previous key and move to SPYRIA_SECRETS_KEY when they next start (an idle runtime stops after an hour): keep SPYRIA_PREVIOUS_SECRETS_KEYS until this command reports none`,
    )
  },
  'workspace:restore': async () => {
    const [workspaceId] = options
    if (!workspaceId) throw new Error('Usage: bun run operator workspace:restore <id>')
    await restoreWorkspace(database, workspaceId)
    console.log(`Workspace ${workspaceId} is restored: its members can sign in again`)
  },
  'workspace:purge': async () => {
    const [workspaceId] = options
    if (!workspaceId) throw new Error('Usage: bun run operator workspace:purge <id> [--abandon-failed-cleanup]')
    if (options.includes('--abandon-failed-cleanup'))
      for (const { type, lastError } of await abandonFailedCleanup(database, workspaceId))
        console.log(`Abandoned the failed ${type}: ${lastError ?? 'no error recorded'}`)
    await purgeWorkspaceNow(database, workspaceId)
    console.log(`Workspace ${workspaceId} is being purged now`)
  },
  'retry-jobs': async () => {
    const [target] = options
    if (!target) throw new Error('Usage: bun run jobs:retry <id>|--all')
    const { requeued, dropped } = await retryFailedJobs(database, target === '--all' ? 'all' : target)
    if (requeued.length + dropped.length === 0) console.log('No failed job matched')
    if (requeued.length > 0) console.log(`Requeued ${requeued.join(', ')}`)
    if (dropped.length > 0) console.log(`Dropped ${dropped.join(', ')}, a sweep already scheduled`)
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

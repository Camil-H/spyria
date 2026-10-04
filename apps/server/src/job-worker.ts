import { setTimeout as sleep } from 'node:timers/promises'
import { conversationJobs } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { type WorkspaceId, workspaceId } from '@hq/kernel'
import type { ServerTransaction } from '@rocicorp/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { sessionJobs } from './auth/sessions.ts'

type JobHandler = (tx: ServerTransaction, workspaceId: WorkspaceId, payload: unknown) => Promise<unknown>
type ClaimedJob = { workspace_id: string; id: string; type: string; payload: unknown; attempts: number }

const jobHandlers: Record<string, JobHandler | undefined> = { ...conversationJobs, ...sessionJobs }
export const maximumJobAttempts = 5

export const startJobWorker = (
  database: Database,
  { pollIntervalMilliseconds = 100, retryDelayMilliseconds = 1000 } = {},
) => {
  const zeroDatabase = zeroDrizzle(schema, database)
  let isRunning = true
  let hasLoggedPollFailure = false
  const runNextJob = () =>
    zeroDatabase.transaction(async (tx) => {
      const query = async (statement: string, parameters: unknown[] = []) => [
        ...(await tx.dbTransaction.query(statement, parameters)),
      ]
      const [job] = (await query(
        `select workspace_id, id, type, payload, attempts from jobs
         where state = 'queued' and run_at <= now() and type = any($1::text[])
         order by run_at limit 1 for update skip locked`,
        [Object.keys(jobHandlers)],
      )) as ClaimedJob[]
      if (!job) return false
      const jobKey = [job.workspace_id, job.id]
      const attempts = job.attempts + 1
      await query(`update jobs set state = 'done', attempts = $3 where workspace_id = $1 and id = $2`, [
        ...jobKey,
        attempts,
      ])
      await query('savepoint job')
      try {
        await jobHandlers[job.type]?.(tx, workspaceId(job.workspace_id), job.payload)
      } catch (error) {
        await query('rollback to savepoint job')
        const state = attempts >= maximumJobAttempts ? 'failed' : 'queued'
        await query(
          `update jobs set state = $3, last_error = $4,
             run_at = now() + make_interval(secs => $5::double precision / 1000)
           where workspace_id = $1 and id = $2`,
          [
            ...jobKey,
            state,
            error instanceof Error ? error.message : String(error),
            state === 'failed' ? 0 : attempts * retryDelayMilliseconds,
          ],
        )
        if (state === 'failed') console.error(`Job ${job.id} (${job.type}) failed after ${attempts} attempts`, error)
      }
      return true
    })
  const pollUntilStopped = async () => {
    while (isRunning) {
      const hasRunJob = await runNextJob().then(
        (hasRun) => {
          hasLoggedPollFailure = false
          return hasRun
        },
        (error) => {
          if (!hasLoggedPollFailure) console.error('The job worker could not poll its queue', error)
          hasLoggedPollFailure = true
          return false
        },
      )
      if (!hasRunJob) await sleep(pollIntervalMilliseconds)
    }
  }
  const polling = pollUntilStopped()
  return {
    stop: async () => {
      isRunning = false
      await polling
    },
  }
}

export const listFailedJobs = (database: Database) =>
  database.$client<
    { workspaceId: string; id: string; type: string; attempts: number; lastError: string | null; failedAt: string }[]
  >`
    select workspace_id as "workspaceId", id, type, attempts, last_error as "lastError", run_at as "failedAt"
    from jobs where state = 'failed' order by run_at`

export const retryFailedJobs = async (database: Database, jobIdOrAll: string) =>
  (
    await database.$client<{ id: string }[]>`
      update jobs set state = 'queued', attempts = 0, run_at = now()
      where state = 'failed' and (${jobIdOrAll} = 'all' or id = ${jobIdOrAll}) returning id`
  ).map((job) => job.id)

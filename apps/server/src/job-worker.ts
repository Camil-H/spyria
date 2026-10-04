import { setTimeout as sleep } from 'node:timers/promises'
import { conversationJobs } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'

type JobHandler = (tx: Transaction, workspaceId: WorkspaceId, payload: unknown) => Promise<unknown>
type ClaimedJob = { workspace_id: string; id: string; type: string; payload: unknown; attempts: number }

const jobHandlers: Record<string, JobHandler | undefined> = conversationJobs
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
      await query('savepoint job')
      try {
        await jobHandlers[job.type]?.(tx, workspaceId(job.workspace_id), job.payload)
        await query(
          `update jobs set state = 'done', attempts = attempts + 1 where workspace_id = $1 and id = $2`,
          jobKey,
        )
      } catch (error) {
        await query('rollback to savepoint job')
        const attempts = job.attempts + 1
        const state = attempts >= maximumJobAttempts ? 'failed' : 'queued'
        await query(
          `update jobs set attempts = $3, state = $4, run_at = now() + make_interval(secs => $5::double precision / 1000)
           where workspace_id = $1 and id = $2`,
          [...jobKey, attempts, state, attempts * retryDelayMilliseconds],
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

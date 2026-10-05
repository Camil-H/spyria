import { setTimeout as sleep } from 'node:timers/promises'
import { conversationJobs } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { type WorkspaceId, workspaceId } from '@hq/kernel'
import { createRuntimeJobs, type SandboxProvider } from '@hq/runtime/server'
import type { ServerTransaction } from '@rocicorp/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { sessionJobs } from './auth/sessions.ts'

type Transact = <Result>(work: (tx: ServerTransaction) => Promise<Result>) => Promise<Result>
type TransactionalJobHandler = (tx: ServerTransaction, workspaceId: WorkspaceId, payload: unknown) => Promise<unknown>
type JobHandler = (job: {
  workspaceId: WorkspaceId
  payload: unknown
  isLastAttempt: boolean
  transact: Transact
}) => Promise<unknown>
type ClaimedJob = { workspace_id: string; id: string; type: string; payload: unknown; attempt: number; lease: string }

export const maximumJobAttempts = 5
const leaseMilliseconds = 5 * 60_000
const claimedJob = `workspace_id = $1 and id = $2 and state = 'running' and run_at = $3::timestamptz`

export const startJobWorker = (
  database: Database,
  {
    pollIntervalMilliseconds = 100,
    retryDelayMilliseconds = 1000,
    concurrency = 4,
    sandboxProvider,
  }: {
    pollIntervalMilliseconds?: number
    retryDelayMilliseconds?: number
    concurrency?: number
    sandboxProvider?: SandboxProvider
  } = {},
) => {
  const transactionalHandlers: Record<string, TransactionalJobHandler | undefined> = {
    ...conversationJobs,
    ...sessionJobs,
  }
  const jobHandlers: Record<string, JobHandler | undefined> = sandboxProvider ? createRuntimeJobs(sandboxProvider) : {}
  const zeroDatabase = zeroDrizzle(schema, database)
  const transact: Transact = (work) => zeroDatabase.transaction(work)
  const jobTypes = [...Object.keys(transactionalHandlers), ...Object.keys(jobHandlers)]
  const runningJobs = new Set<Promise<void>>()
  let isRunning = true
  let hasLoggedPollFailure = false
  const claimNextJob = async () =>
    (
      await database.$client.unsafe<ClaimedJob[]>(
        `update jobs set state = 'running', attempts = attempts + (state = 'running')::int,
           run_at = now() + make_interval(secs => $2::double precision / 1000)
         where (workspace_id, id) = (
           select workspace_id, id from jobs
           where state in ('queued', 'running') and run_at <= now() and type = any($1::text[])
           order by run_at limit 1 for update skip locked)
         returning workspace_id, id, type, payload, attempts + 1 as attempt, run_at::text as lease`,
        [jobTypes, leaseMilliseconds],
      )
    )[0]
  const runJob = async (job: ClaimedJob) => {
    const jobKey = [job.workspace_id, job.id, job.lease]
    const isLastAttempt = job.attempt >= maximumJobAttempts
    const transactional = transactionalHandlers[job.type]
    try {
      if (transactional)
        await transact(async (tx) => {
          const completed = await tx.dbTransaction.query(
            `update jobs set state = 'done', attempts = attempts + 1 where ${claimedJob} returning id`,
            jobKey,
          )
          if ([...completed].length === 0) throw new Error(`Job ${job.id} was claimed again`)
          await transactional(tx, workspaceId(job.workspace_id), job.payload)
        })
      else {
        await jobHandlers[job.type]?.({
          workspaceId: workspaceId(job.workspace_id),
          payload: job.payload,
          isLastAttempt,
          transact,
        })
        await database.$client.unsafe(
          `update jobs set state = 'done', attempts = attempts + 1 where ${claimedJob}`,
          jobKey,
        )
      }
    } catch (error) {
      const state = isLastAttempt ? 'failed' : 'queued'
      await database.$client.unsafe(
        `update jobs set state = $4, last_error = $5, attempts = attempts + 1,
           run_at = now() + make_interval(secs => $6::double precision / 1000)
         where ${claimedJob}`,
        [
          ...jobKey,
          state,
          error instanceof Error ? error.message : String(error),
          isLastAttempt ? 0 : job.attempt * retryDelayMilliseconds,
        ],
      )
      if (isLastAttempt) console.error(`Job ${job.id} (${job.type}) failed after ${job.attempt} attempts`, error)
    }
  }
  const pollUntilStopped = async () => {
    while (isRunning) {
      if (runningJobs.size >= concurrency) {
        await Promise.race(runningJobs)
        continue
      }
      const job = await claimNextJob().then(
        (claimed) => {
          hasLoggedPollFailure = false
          return claimed
        },
        (error) => {
          if (!hasLoggedPollFailure) console.error('The job worker could not poll its queue', error)
          hasLoggedPollFailure = true
          return undefined
        },
      )
      if (!job) {
        await sleep(pollIntervalMilliseconds)
        continue
      }
      const running = runJob(job)
        .catch((error) => console.error(`The job worker could not record the outcome of job ${job.id}`, error))
        .finally(() => runningJobs.delete(running))
      runningJobs.add(running)
    }
    await Promise.all(runningJobs)
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

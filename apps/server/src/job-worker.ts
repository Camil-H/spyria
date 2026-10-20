import { setTimeout as sleep } from 'node:timers/promises'
import type { ServerTransaction } from '@rocicorp/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { Database } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import type { Job, Transact } from '@spyria/db/zero-queries'
import { log, type WorkspaceId, workspaceId } from '@spyria/kernel'
import { type createLlmGateway, createProfileJobs } from '@spyria/profile/server'
import { createRuntimeJobs, type SandboxProvider } from '@spyria/runtime/server'
import { auditJobs, createUsageJobs } from '@spyria/usage/server'
import type { AgentBridge } from './agent-bridge/bridge.ts'
import { sessionJobs } from './auth/sessions.ts'
import { contextOf, withSpan } from './telemetry.ts'

type TransactionalJobHandler = (tx: ServerTransaction, workspaceId: WorkspaceId, payload: unknown) => Promise<unknown>
type JobHandler = (job: Job) => Promise<unknown>
type JobOutcome = keyof typeof jobLogs
type ClaimedJob = {
  workspace_id: string
  id: string
  type: string
  payload: Record<string, unknown>
  attempt: number
  lease: string
}

const jobLogs = {
  done: { severity: 'info', body: 'Job finished' },
  rescheduled: { severity: 'info', body: 'Job rescheduled' },
  retried: { severity: 'warn', body: 'Job failed and will be retried' },
  failed: { severity: 'error', body: 'Job failed after its last attempt' },
} as const

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
    agentBridge,
    llmGateway,
    usageLogs,
  }: {
    pollIntervalMilliseconds?: number
    retryDelayMilliseconds?: number
    concurrency?: number
    sandboxProvider?: SandboxProvider
    agentBridge?: AgentBridge
    llmGateway?: ReturnType<typeof createLlmGateway>
    usageLogs?: Parameters<typeof createUsageJobs>[0]
  } = {},
) => {
  const transactionalHandlers: Record<string, TransactionalJobHandler | undefined> = sessionJobs
  const jobHandlers: Record<string, JobHandler | undefined> = {
    ...(sandboxProvider && createRuntimeJobs(sandboxProvider)),
    ...agentBridge?.forDatabase(database).jobs,
    ...(llmGateway && createProfileJobs(llmGateway)),
    ...(usageLogs && createUsageJobs(usageLogs)),
    ...auditJobs,
  }
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
  const runJob = ({ payload: { traceparent, tracestate, ...payload }, ...claimed }: ClaimedJob) => {
    const job = { ...claimed, payload }
    const startedAt = performance.now()
    const attributes = {
      'job.id': job.id,
      'job.type': job.type,
      'job.attempt': job.attempt,
      'workspace.id': job.workspace_id,
    }
    return withSpan(
      `job ${job.type}`,
      attributes,
      async () => {
        const { outcome, error } = await runClaimedJob(job)
        log[jobLogs[outcome].severity]({
          event: 'job.run',
          body: jobLogs[outcome].body,
          attributes: { ...attributes, 'job.outcome': outcome, duration_ms: Math.round(performance.now() - startedAt) },
          error,
        })
      },
      contextOf({ traceparent, tracestate }),
    )
  }
  const runClaimedJob = async (job: ClaimedJob): Promise<{ outcome: JobOutcome; error?: unknown }> => {
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
        const outcome = (await jobHandlers[job.type]?.({
          workspaceId: workspaceId(job.workspace_id),
          payload: job.payload,
          isLastAttempt,
          transact,
        })) as { retryInMilliseconds?: number } | undefined
        await database.$client.unsafe(
          outcome?.retryInMilliseconds === undefined
            ? `update jobs set state = 'done', attempts = attempts + 1 where ${claimedJob}`
            : `update jobs set state = 'queued', run_at = now() + make_interval(secs => $4::double precision / 1000)
               where ${claimedJob}`,
          outcome?.retryInMilliseconds === undefined ? jobKey : [...jobKey, outcome.retryInMilliseconds],
        )
        if (outcome?.retryInMilliseconds !== undefined) return { outcome: 'rescheduled' }
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
      return { outcome: isLastAttempt ? 'failed' : 'retried', error }
    }
    return { outcome: 'done' }
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
          if (!hasLoggedPollFailure)
            log.error({ event: 'job.poll_failed', body: 'The job worker could not poll its queue', error })
          hasLoggedPollFailure = true
          return undefined
        },
      )
      if (!job) {
        await sleep(pollIntervalMilliseconds)
        continue
      }
      const running = runJob(job)
        .catch((error) =>
          log.error({
            event: 'job.record_failed',
            body: 'The job worker could not record the outcome of a job',
            attributes: { 'job.id': job.id, 'job.type': job.type },
            error,
          }),
        )
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

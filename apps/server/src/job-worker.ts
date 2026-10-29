import type { ServerTransaction } from '@rocicorp/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { Database } from '@spyria/db/postgres'
import { jobTypesOfDeletedWorkspaces } from '@spyria/db/server-writes'
import { schema } from '@spyria/db/zero'
import type { Job, Transact } from '@spyria/db/zero-queries'
import { errorSummaryOf, log, type WorkspaceId, workspaceId } from '@spyria/kernel'
import { type createLlmGateway, createProfileJobs } from '@spyria/profile/server'
import { createRuntimeJobs, type SandboxProvider } from '@spyria/runtime/server'
import { auditJobs, createUsageJobs } from '@spyria/usage/server'
import { createWorkspaceJobs } from '@spyria/workspace/server'
import type { AgentBridge } from './agent-bridge/bridge.ts'
import { recurringJobTypes, sessionJobs } from './auth/sessions.ts'
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
const queuedJobsChannel = 'jobs_queued'
const claimedJob = `workspace_id = $1 and id = $2 and state = 'running' and claimed_at = $3::timestamptz`

export const startJobWorker = (
  database: Database,
  {
    pollIntervalMilliseconds = 1000,
    retryDelayMilliseconds = 1000,
    leaseMilliseconds = 5 * 60_000,
    concurrency = 4,
    cleanupPollMilliseconds = 30_000,
    failedCleanupRetryMilliseconds = 60 * 60_000,
    sandboxProvider,
    agentBridge,
    llmGateway,
    usageLogs,
  }: {
    pollIntervalMilliseconds?: number
    retryDelayMilliseconds?: number
    leaseMilliseconds?: number
    concurrency?: number
    cleanupPollMilliseconds?: number
    failedCleanupRetryMilliseconds?: number
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
    ...createWorkspaceJobs({ cleanupPollMilliseconds, failedCleanupRetryMilliseconds }),
  }
  const zeroDatabase = zeroDrizzle(schema, database)
  const transact: Transact = (work) => zeroDatabase.transaction(work)
  const jobTypes = [...Object.keys(transactionalHandlers), ...Object.keys(jobHandlers)]
  const runningJobs = new Set<Promise<void>>()
  let isRunning = true
  let hasLoggedPollFailure = false
  let isJobQueuedSinceClaim = false
  let wakeUp = () => {}
  const waitForQueuedJob = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMilliseconds)
      wakeUp = () => {
        clearTimeout(timer)
        resolve()
      }
      if (isJobQueuedSinceClaim || !isRunning) wakeUp()
    })
  const listening = database.$client
    .listen(queuedJobsChannel, () => {
      isJobQueuedSinceClaim = true
      wakeUp()
    })
    .catch((error) => {
      log.warn({ event: 'job.listen_failed', body: 'The job worker polls its queue without notifications', error })
      return undefined
    })
  const claimNextJob = async () =>
    (
      await database.$client.unsafe<ClaimedJob[]>(
        `update jobs set state = 'running', attempts = attempts + (state = 'running')::int, claimed_at = now(),
           run_at = now() + make_interval(secs => $2::double precision / 1000)
         where (workspace_id, id) = (
           select workspace_id, id from jobs
           where state in ('queued', 'running') and run_at <= now() and type = any($1::text[])
             and (type = any($3::text[]) or not exists(select 1 from workspaces
               where workspaces.workspace_id = jobs.workspace_id and workspaces.deleted_at is not null))
           order by run_at limit 1 for update skip locked)
         returning workspace_id, id, type, payload, attempts + 1 as attempt, claimed_at::text as lease`,
        [jobTypes, leaseMilliseconds, jobTypesOfDeletedWorkspaces],
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
        if (outcome === 'done' && recurringJobTypes.includes(job.type)) return
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
  const whileLeaseExtended = async <Result>(jobKey: string[], work: () => Promise<Result>) => {
    let extending: Promise<unknown> | undefined
    const extendLease = () => {
      extending ??= database.$client
        .unsafe(
          `update jobs set run_at = now() + make_interval(secs => $4::double precision / 1000) where ${claimedJob}`,
          [...jobKey, leaseMilliseconds],
        )
        .catch((error) =>
          log.warn({ event: 'job.lease_extension_failed', body: 'The job worker could not extend a lease', error }),
        )
        .finally(() => {
          extending = undefined
        })
    }
    const timer = setInterval(extendLease, leaseMilliseconds / 3)
    try {
      return await work()
    } finally {
      clearInterval(timer)
      await extending
    }
  }
  const runClaimedJob = async (job: ClaimedJob): Promise<{ outcome: JobOutcome; error?: unknown }> => {
    const jobKey = [job.workspace_id, job.id, job.lease]
    const isLastAttempt = job.attempt >= maximumJobAttempts
    const transactional = transactionalHandlers[job.type]
    try {
      if (transactional)
        await transact(async (tx) => {
          const completed = await tx.dbTransaction.query(
            `update jobs set state = 'done', attempts = attempts + 1, finished_at = now() where ${claimedJob} returning id`,
            jobKey,
          )
          if ([...completed].length === 0) throw new Error(`Job ${job.id} was claimed again`)
          await transactional(tx, workspaceId(job.workspace_id), job.payload)
        })
      else {
        const outcome = (await whileLeaseExtended(jobKey, async () =>
          jobHandlers[job.type]?.({
            workspaceId: workspaceId(job.workspace_id),
            payload: job.payload,
            isLastAttempt,
            isRetry: job.attempt > 1,
            transact,
          }),
        )) as { retryInMilliseconds?: number } | undefined
        await database.$client.unsafe(
          outcome?.retryInMilliseconds === undefined
            ? `update jobs set state = 'done', attempts = attempts + 1, finished_at = now() where ${claimedJob}`
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
           run_at = now() + make_interval(secs => $6::double precision / 1000),
           finished_at = case when $4 = 'failed' then now() end
         where ${claimedJob}`,
        [...jobKey, state, errorSummaryOf(error), isLastAttempt ? 0 : job.attempt * retryDelayMilliseconds],
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
      isJobQueuedSinceClaim = false
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
        await waitForQueuedJob()
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
      wakeUp()
      await polling
      await (await listening)?.unlisten()
    },
  }
}

export const listFailedJobs = (database: Database) =>
  database.$client<
    { workspaceId: string; id: string; type: string; attempts: number; lastError: string | null; failedAt: string }[]
  >`
    select workspace_id as "workspaceId", id, type, attempts, last_error as "lastError", finished_at as "failedAt"
    from jobs where state = 'failed' order by finished_at`

export const retryFailedJobs = async (database: Database, jobIdOrAll: string) =>
  (
    await database.$client<{ id: string }[]>`
      update jobs set state = 'queued', attempts = 0, run_at = now(), finished_at = null
      where state = 'failed' and (${jobIdOrAll} = 'all' or id = ${jobIdOrAll}) returning id`
  ).map((job) => job.id)

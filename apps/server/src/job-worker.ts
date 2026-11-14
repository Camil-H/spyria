import type { ServerTransaction } from '@rocicorp/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { Database } from '@spyria/db/postgres'
import { jobTypesOfDeletedWorkspaces } from '@spyria/db/server-writes'
import { schema } from '@spyria/db/zero'
import type { Job, Transact } from '@spyria/db/zero-queries'
import { errorSummaryOf, log, type WorkspaceId, workspaceId } from '@spyria/kernel'
import { type createLlmGateway, createProfileJobs } from '@spyria/profile/server'
import { createRuntimeJobs, type RepositoryAccess, type SandboxProvider } from '@spyria/runtime/server'
import { auditJobs, createUsageJobs } from '@spyria/usage/server'
import { createWorkspaceJobs } from '@spyria/workspace/server'
import type { AgentBridge } from './agent-bridge/bridge.ts'
import { recurringJobTypes, sessionJobs } from './auth/sessions.ts'
import { contextOf, withSpan } from './telemetry.ts'
import { toolListChangesOf } from './tool-list-changes.ts'

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
  superseded: { severity: 'warn', body: 'Job failed and a newer job with its serial key will redo it' },
  failed: { severity: 'error', body: 'Job failed after its last attempt' },
} as const

export const maximumJobAttempts = 5
const cleanupRetryGrowth = 5
const cleanupJobTypes = new Set<string>(jobTypesOfDeletedWorkspaces)

export const retryDelayOf = (
  jobType: string,
  attempt: number,
  {
    retryDelayMilliseconds,
    cleanupRetryDelayMilliseconds,
    maximumCleanupRetryDelayMilliseconds,
  }: {
    retryDelayMilliseconds: number
    cleanupRetryDelayMilliseconds: number
    maximumCleanupRetryDelayMilliseconds: number
  },
) =>
  cleanupJobTypes.has(jobType)
    ? Math.min(
        cleanupRetryDelayMilliseconds * cleanupRetryGrowth ** (attempt - 1),
        maximumCleanupRetryDelayMilliseconds,
      )
    : attempt * retryDelayMilliseconds

const isOneQueuedJobType = (type: string) => type.endsWith('.sweep') || type === 'usage.sync'
const abandonedJobError = 'The server stopped while running this job'
const queuedJobsChannel = 'jobs_queued'
const uniqueViolation = '23505'
const claimedJob = `workspace_id = $1 and id = $2 and state = 'running' and claimed_at = $3::timestamptz`

export const startJobWorker = (
  database: Database,
  {
    pollIntervalMilliseconds = 1000,
    retryDelayMilliseconds = 1000,
    cleanupRetryDelayMilliseconds = 5000,
    maximumCleanupRetryDelayMilliseconds = 5 * 60_000,
    leaseMilliseconds = 5 * 60_000,
    maximumRunMilliseconds = 30 * 60_000,
    concurrency = 4,
    cleanupPollMilliseconds = 30_000,
    failedCleanupRetryMilliseconds = 60 * 60_000,
    sandboxProvider,
    spyriaAgentImage,
    repositoryAccess,
    warmCheckMilliseconds,
    agentBridge,
    llmGateway,
    usageLogs,
  }: {
    pollIntervalMilliseconds?: number
    retryDelayMilliseconds?: number
    cleanupRetryDelayMilliseconds?: number
    maximumCleanupRetryDelayMilliseconds?: number
    leaseMilliseconds?: number
    maximumRunMilliseconds?: number
    concurrency?: number
    cleanupPollMilliseconds?: number
    failedCleanupRetryMilliseconds?: number
    sandboxProvider?: SandboxProvider
    spyriaAgentImage?: string
    repositoryAccess?: RepositoryAccess
    warmCheckMilliseconds?: number
    agentBridge?: AgentBridge
    llmGateway?: ReturnType<typeof createLlmGateway>
    usageLogs?: Parameters<typeof createUsageJobs>[0]
  } = {},
) => {
  const retryDelays = { retryDelayMilliseconds, cleanupRetryDelayMilliseconds, maximumCleanupRetryDelayMilliseconds }
  const transactionalHandlers: Record<string, TransactionalJobHandler | undefined> = sessionJobs
  const jobHandlers: Record<string, JobHandler | undefined> = {
    ...(sandboxProvider &&
      createRuntimeJobs(sandboxProvider, {
        currentImage: spyriaAgentImage,
        repositories: repositoryAccess,
        warmCheckMilliseconds,
      })),
    ...agentBridge?.forDatabase(database).jobs,
    ...(llmGateway && createProfileJobs(llmGateway, toolListChangesOf(database).announceToolListChange)),
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
  let hasLoggedListenFailure = false
  let wakeUp = () => {}
  let listening: Promise<{ unlisten: () => Promise<void> } | undefined> | undefined
  const listenUnlessListening = () => {
    listening ??= database.$client
      .listen(queuedJobsChannel, () => {
        isJobQueuedSinceClaim = true
        wakeUp()
      })
      .then(
        (listener) => {
          hasLoggedListenFailure = false
          return listener
        },
        (error) => {
          if (!hasLoggedListenFailure)
            log.warn({
              event: 'job.listen_failed',
              body: 'The job worker polls its queue without notifications',
              error,
            })
          hasLoggedListenFailure = true
          listening = undefined
          return undefined
        },
      )
  }
  const millisecondsUntilNextJob = async () => {
    const [next] = await database.$client.unsafe<{ waitMilliseconds: number | null }[]>(
      `select (extract(epoch from min(run_at) - now()) * 1000)::float8 as "waitMilliseconds"
       from jobs where state in ('queued', 'running') and run_at > now() and type = any($1::text[])`,
      [jobTypes],
    )
    return next?.waitMilliseconds ?? pollIntervalMilliseconds
  }
  const waitForQueuedJob = async () => {
    listenUnlessListening()
    const waitMilliseconds = Math.min(
      pollIntervalMilliseconds,
      await millisecondsUntilNextJob().catch(() => pollIntervalMilliseconds),
    )
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMilliseconds)
      wakeUp = () => {
        clearTimeout(timer)
        resolve()
      }
      if (isJobQueuedSinceClaim || !isRunning) wakeUp()
    })
  }
  listenUnlessListening()
  const claimNextJob = async () =>
    (
      await database.$client.unsafe<ClaimedJob[]>(
        `update jobs set state = 'running', attempts = attempts + (state = 'running')::int, claimed_at = now(),
           run_at = now() + make_interval(secs => $2::double precision / 1000)
         where (workspace_id, id) = (
           select workspace_id, id from jobs
           where state in ('queued', 'running') and run_at <= now() and type = any($1::text[])
             and (serial_key is null or not exists(select 1 from jobs as running
               where running.workspace_id = jobs.workspace_id and running.serial_key = jobs.serial_key
                 and running.state = 'running' and running.id <> jobs.id))
             and (type = any($3::text[]) or not exists(select 1 from workspaces
               where workspaces.workspace_id = jobs.workspace_id and workspaces.deleted_at is not null))
           order by run_at limit 1 for update skip locked)
         returning workspace_id, id, type, payload, attempts + 1 as attempt, claimed_at::text as lease`,
        [jobTypes, leaseMilliseconds, jobTypesOfDeletedWorkspaces],
      )
    )[0]
  const failAbandonedJobs = async () => {
    const abandoned = await database.$client.unsafe<{ workspace_id: string; id: string; type: string }[]>(
      `update jobs set state = 'failed', attempts = attempts + 1, finished_at = now(), last_error = $3
       where state = 'running' and run_at <= now() and attempts + 1 >= $2 and type = any($1::text[])
       returning workspace_id, id, type`,
      [jobTypes, maximumJobAttempts, abandonedJobError],
    )
    for (const job of abandoned)
      log.error({
        event: 'job.run',
        body: jobLogs.failed.body,
        attributes: {
          'job.id': job.id,
          'job.type': job.type,
          'job.attempt': maximumJobAttempts,
          'job.outcome': 'failed',
          'workspace.id': job.workspace_id,
        },
        error: new Error(abandonedJobError),
      })
  }
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
    const extendUntil = Date.now() + maximumRunMilliseconds
    const timer = setInterval(() => {
      if (Date.now() < extendUntil) extendLease()
      else clearInterval(timer)
    }, leaseMilliseconds / 3)
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
      const recordFailure = (isSuperseded: boolean) =>
        database.$client.unsafe<{ isFailed: boolean; isSuperseded: boolean }[]>(
          `with outcome as (
           select $9::boolean or exists(select 1 from jobs as this_run join jobs as next_run
               on next_run.workspace_id = this_run.workspace_id and next_run.serial_key = this_run.serial_key
               where this_run.workspace_id = $1 and this_run.id = $2 and next_run.state = 'queued') as is_superseded,
             $4::boolean or ($7::boolean and exists(select 1 from jobs as next_run
               where next_run.workspace_id = $1 and next_run.type = $8 and next_run.state = 'queued')) as is_failed)
         update jobs set state = case when is_superseded then 'done' when is_failed then 'failed' else 'queued' end,
           last_error = $5, attempts = attempts + 1,
           run_at = now() + make_interval(secs => $6::double precision / 1000),
           finished_at = case when is_superseded or is_failed then now() end
         from outcome where ${claimedJob}
         returning is_failed and not is_superseded as "isFailed", is_superseded as "isSuperseded"`,
          [
            ...jobKey,
            isLastAttempt,
            errorSummaryOf(error),
            isLastAttempt ? 0 : retryDelayOf(job.type, job.attempt, retryDelays),
            isOneQueuedJobType(job.type),
            job.type,
            isSuperseded,
          ],
        )
      const [recorded] = await recordFailure(false).catch((recordError: unknown) =>
        (recordError as { code?: string }).code === uniqueViolation ? recordFailure(true) : Promise.reject(recordError),
      )
      if (recorded?.isSuperseded) return { outcome: 'superseded', error }
      return { outcome: (recorded?.isFailed ?? isLastAttempt) ? 'failed' : 'retried', error }
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
      const job = await failAbandonedJobs()
        .then(claimNextJob)
        .then(
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
        .finally(() => {
          runningJobs.delete(running)
          isJobQueuedSinceClaim = true
          wakeUp()
        })
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
    whenListening: async () => {
      await listening
    },
  }
}

export const listFailedJobs = (database: Database) =>
  database.$client<
    { workspaceId: string; id: string; type: string; attempts: number; lastError: string | null; failedAt: string }[]
  >`
    select workspace_id as "workspaceId", id, type, attempts, last_error as "lastError", finished_at as "failedAt"
    from jobs where state = 'failed' order by finished_at`

export const retryFailedJobs = async (database: Database, jobIdOrAll: string) => {
  const retried = await database.$client<{ id: string; isRequeued: boolean }[]>`
    with matched as (
      select workspace_id, id, ((type like '%.sweep' or type = 'usage.sync') and (
        exists(select 1 from jobs as queued
          where queued.workspace_id = jobs.workspace_id and queued.type = jobs.type and queued.state = 'queued')
        or row_number() over (partition by workspace_id, type order by finished_at desc nulls last, id) > 1
      )) or (serial_key is not null and (
        exists(select 1 from jobs as queued
          where queued.workspace_id = jobs.workspace_id and queued.serial_key = jobs.serial_key and queued.state = 'queued')
        or row_number() over (partition by workspace_id, serial_key order by finished_at desc nulls last, id) > 1
      )) as is_superseded
      from jobs where state = 'failed' and (${jobIdOrAll} = 'all' or id = ${jobIdOrAll})),
    superseded as (
      delete from jobs using matched
      where (jobs.workspace_id, jobs.id) = (matched.workspace_id, matched.id) and matched.is_superseded
      returning jobs.id),
    requeued as (
      update jobs set state = 'queued', attempts = 0, run_at = now(), finished_at = null from matched
      where (jobs.workspace_id, jobs.id) = (matched.workspace_id, matched.id) and not matched.is_superseded
      returning jobs.id)
    select id, false as "isRequeued" from superseded union all select id, true from requeued`
  return {
    requeued: retried.filter((job) => job.isRequeued).map((job) => job.id),
    dropped: retried.filter((job) => !job.isRequeued).map((job) => job.id),
  }
}

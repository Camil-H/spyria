import { type MessageId, messageId, systemActor, type WorkspaceId } from '@spyria/kernel'
import type { AgentChat, AgentEndpoint } from '../contracts/agent.ts'
import type { UnitOfWork } from '../contracts/transactor.ts'
import {
  blockingFindingsOf,
  type CheckResult,
  checksFixPromptOf,
  checksPollMilliseconds,
  ciFixPromptOf,
  ciPollMilliseconds,
  ciQuietMilliseconds,
  ciVerdictOf,
  commandGroupAt,
  countedRunsOf,
  type DevLoopPromptStep,
  type DevLoopStep,
  devLoopJobTypes,
  failedAt,
  finished,
  handOffOutcomeOf,
  limitOutcomeOf,
  newFindingsOf,
  noCiOutcomeOf,
  notRunOutcome,
  pausedOutcome,
  readyOutcomeOf,
  reconsiderPromptOf,
  restarted,
  reviewFixPromptOf,
  reviewRequestOf,
  stepNameOf,
  stopOutcomeOf,
  stopped,
  turnedOffOutcome,
  withOutcomes,
} from '../domain/dev-loop.ts'
import { checkRunsTextOf } from '../domain/github-tools.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { agentWorkspacePathOf, runtimeHeadsOf } from '../domain/workspace-reads.ts'
import { type AgentDependencies, appendNotice } from './agent-turn.ts'
import { devLoopActor, type Loop, loopOf, saveLoop } from './dev-loop-turns.ts'
import { publishBranch } from './publish-branch.ts'

type Dependencies = Pick<
  AgentDependencies,
  'transactor' | 'runtimes' | 'agentClient' | 'checkouts' | 'isBudgetUsedUp' | 'devLoopPollMilliseconds'
>
type LoopJob = { workspaceId: WorkspaceId; loopId: MessageId }
type ChecksRun = { state?: string; id?: string | null; results?: CheckResult[] }

const chatOf = ({ card }: Loop): AgentChat => ({ workspaceId: card.workspaceId, chatId: card.chatId })
const checksPollOf = ({ devLoopPollMilliseconds }: Dependencies) => devLoopPollMilliseconds ?? checksPollMilliseconds
const ciPollOf = ({ devLoopPollMilliseconds }: Dependencies) => devLoopPollMilliseconds ?? ciPollMilliseconds

const endLoop = async (unitOfWork: UnitOfWork, loop: Loop, step: DevLoopStep) => {
  await saveLoop(unitOfWork, loop, step)
  if (step.outcome) await appendNotice(unitOfWork, await unitOfWork.messages.get(step.lastPromptId), step.outcome)
}

const postLoopPrompt = async (
  unitOfWork: UnitOfWork,
  loop: Loop,
  step: DevLoopStep,
  text: string,
  phase: DevLoopPromptStep['phase'],
) => {
  const prompt = newMessage({
    id: messageId(crypto.randomUUID()),
    workspaceId: loop.card.workspaceId,
    chatId: loop.card.chatId,
    kind: 'member',
    authorId: loop.ownerId,
    body: MessageBody(text),
    step: { type: 'dev_loop_prompt', loopId: loop.card.id, phase },
    createdAt: new Date(),
    replyToId: null,
  })
  await unitOfWork.messages.record({
    type: 'message.posted',
    actor: systemActor(devLoopActor, loop.ownerId),
    message: prompt,
  })
  await saveLoop(unitOfWork, loop, { ...step, lastPromptId: prompt.id })
  await unitOfWork.agentJobs.prompt(prompt)
}

const moveOn = async (unitOfWork: UnitOfWork, loop: Loop, step: DevLoopStep, position: number) => {
  await saveLoop(unitOfWork, loop, { ...step, state: 'running', next: null, position })
  await unitOfWork.devLoop.enqueue(devLoopJobTypes.run, loop.card.id)
}

const sendBack = (unitOfWork: UnitOfWork, loop: Loop, failing: number[], promptOf: (rounds: number[]) => string) => {
  const { rounds, kind, name, limit } = failedAt(loop.step, failing)
  const step = withOutcomes(
    { ...loop.step, rounds, next: null },
    failing.map((index) => [index, 'failed']),
  )
  const phase = loop.step.pipeline[failing[0] ?? 0]?.kind ?? 'command'
  if (kind === 'stop') return endLoop(unitOfWork, loop, stopped(step, stopOutcomeOf(name)))
  if (kind === 'reconsider')
    return postLoopPrompt(
      unitOfWork,
      loop,
      { ...step, state: 'handing_off', outcome: handOffOutcomeOf(name, limit) },
      reconsiderPromptOf(name, limit),
      phase,
    )
  return postLoopPrompt(unitOfWork, loop, { ...step, state: 'working' }, promptOf(rounds), phase)
}

const lockedLoopOf = async (unitOfWork: UnitOfWork, loopId: MessageId) => {
  const card = await unitOfWork.messages.find(loopId)
  if (!card) return undefined
  await unitOfWork.agentTurns.lock(card.chatId)
  return loopOf(await unitOfWork.messages.find(loopId))
}

const limitOrBudgetOutcomeOf = async ({ isBudgetUsedUp }: Dependencies, unitOfWork: UnitOfWork, loop: Loop) => {
  const chat = await unitOfWork.chats.get(loop.card.chatId)
  const costMicros = chat.localSession
    ? null
    : await unitOfWork.devLoop.costSince(loop.card.chatId, loop.step.startedAt)
  const limit = limitOutcomeOf(loop.step, Date.now(), costMicros)
  if (limit) return limit
  if (!chat.localSession && (await isBudgetUsedUp?.(loop.card.workspaceId, loop.ownerId)))
    return `Stopped: the monthly AI budget of ${await unitOfWork.members.displayNameOf(loop.ownerId)} is used up`
  return undefined
}

const withLoop = <Result>(
  dependencies: Dependencies,
  { loopId }: LoopJob,
  states: DevLoopStep['state'][],
  work: (unitOfWork: UnitOfWork, loop: Loop) => Promise<Result>,
) =>
  dependencies.transactor.run(async (unitOfWork) => {
    const loop = await lockedLoopOf(unitOfWork, loopId)
    if (!loop || !states.includes(loop.step.state)) return undefined
    const settings = await unitOfWork.devLoop.settings()
    const outcome = settings?.isOn ? await limitOrBudgetOutcomeOf(dependencies, unitOfWork, loop) : turnedOffOutcome
    if (outcome) {
      await endLoop(unitOfWork, loop, stopped(loop.step, outcome))
      return undefined
    }
    return work(unitOfWork, loop)
  })

const loopIn = (dependencies: Dependencies, job: LoopJob) =>
  dependencies.transactor.run(async ({ messages }) => loopOf(await messages.find(job.loopId)))

const endpointOfLoop = ({ runtimes }: Dependencies, loop: Loop) => runtimes.endpointOf(chatOf(loop))

const headOf = async ({ transactor, agentClient }: Dependencies, loop: Loop, endpoint: AgentEndpoint | undefined) => {
  if (!endpoint) return null
  const { baseBranch } = await transactor.run(({ chats }) => chats.get(loop.card.chatId))
  const status = await agentClient
    .readWorkspace(endpoint, agentWorkspacePathOf('status', '', baseBranch ?? ''))
    .catch(() => undefined)
  return runtimeHeadsOf(status)[0] ?? null
}

export const continueLoopAfterTurn = (dependencies: Dependencies, job: LoopJob) =>
  withLoop(dependencies, job, ['working', 'reviewing', 'handing_off'], async (unitOfWork, loop) => {
    const { step } = loop
    if (step.state === 'handing_off') return endLoop(unitOfWork, loop, stopped(step, step.outcome ?? pausedOutcome))
    if (step.state === 'working' && step.next === 'run') return moveOn(unitOfWork, loop, restarted(step), 0)
    if (step.state === 'reviewing' && step.next === 'review_verdict') {
      const fresh = newFindingsOf(step, step.reportedFindings ?? [])
      const blocking = blockingFindingsOf(fresh)
      const reviewed = {
        ...step,
        findings: [...step.findings, ...fresh],
        reviewedHead: step.checkedHead,
        reportedFindings: null,
      }
      if (blocking.length === 0)
        return moveOn(unitOfWork, loop, withOutcomes(reviewed, [[step.position, 'passed']]), step.position + 1)
      return sendBack(unitOfWork, { ...loop, step: reviewed }, [step.position], (rounds) =>
        reviewFixPromptOf(blocking, rounds[step.position] ?? 1, failedAt(step, [step.position]).limit),
      )
    }
    const hasRun = await unitOfWork.agentTurns.hasReply(step.lastPromptId)
    return endLoop(unitOfWork, loop, stopped(step, hasRun ? pausedOutcome : notRunOutcome))
  })

const startCommands = async (dependencies: Dependencies, job: LoopJob, loop: Loop, group: number[]) => {
  const endpoint = await endpointOfLoop(dependencies, loop)
  const checks = group.flatMap((index) => {
    const config = loop.step.pipeline[index]
    return config?.kind === 'command'
      ? [{ name: config.name, command: config.command, timeout_minutes: config.timeoutMinutes }]
      : []
  })
  const runId = crypto.randomUUID()
  const started = endpoint
    ? await dependencies.agentClient
        .actOnWorkspace(endpoint, 'checks', { checks, run_id: runId })
        .catch(() => ({ failure: 'The runtime could not start the checks: over to you' }))
    : { failure: 'The runtime stopped before the checks ran: over to you' }
  if ('failure' in started)
    return withLoop(dependencies, job, ['running'], (unitOfWork, current) =>
      endLoop(unitOfWork, current, stopped(current.step, String(started.failure))),
    )
  if ((started as ChecksRun).id !== runId) return keepPolling(dependencies, job, 'running', checksPollOf(dependencies))
  return withLoop(dependencies, job, ['running'], async (unitOfWork, current) => {
    await saveLoop(unitOfWork, current, { ...current.step, checksRunId: runId })
    await unitOfWork.devLoop.enqueue(devLoopJobTypes.pollChecks, job.loopId, checksPollOf(dependencies))
  })
}

const publish = async (dependencies: Dependencies, job: LoopJob, loop: Loop) => {
  const head = await headOf(dependencies, loop, await endpointOfLoop(dependencies, loop))
  if (head !== null && loop.step.checkedHead !== null && head !== loop.step.checkedHead)
    return withLoop(dependencies, job, ['running'], (unitOfWork, current) =>
      moveOn(unitOfWork, current, restarted(current.step), 0),
    )
  const published = await publishBranch(dependencies, {
    chat: chatOf(loop),
    actor: systemActor(devLoopActor, loop.ownerId),
    action: 'pull_request',
    draft: loop.step.summary,
  })
  return withLoop(dependencies, job, ['running'], async (unitOfWork, current) => {
    if (published.isRefused) return endLoop(unitOfWork, current, stopped(current.step, published.text))
    const card = await unitOfWork.messages.pullRequestCard(current.card.chatId)
    const pullRequest = card?.step?.type === 'pull_request' ? card.step : undefined
    const step = withOutcomes(
      {
        ...current.step,
        pullRequestNumber: pullRequest?.number ?? null,
        pushedHead: pullRequest?.headSha ?? null,
        publishedAt: Date.now(),
      },
      [[current.step.position, 'passed']],
    )
    return moveOn(unitOfWork, current, step, current.step.position + 1)
  })
}

export const runLoop = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await loopIn(dependencies, job)
  if (loop?.step.state !== 'running') return undefined
  const { position, pipeline } = loop.step
  const config = pipeline[position]
  if (position === 0 && loop.step.checkedHead === null) {
    const head = await headOf(dependencies, loop, await endpointOfLoop(dependencies, loop))
    if (head !== null)
      return withLoop(dependencies, job, ['running'], (unitOfWork, current) =>
        moveOn(unitOfWork, current, { ...current.step, checkedHead: head }, 0),
      )
  }
  if (!config)
    return withLoop(dependencies, job, ['running'], (unitOfWork, current) =>
      endLoop(unitOfWork, current, finished(current.step, readyOutcomeOf(current.step))),
    )
  if (config.kind === 'command') return startCommands(dependencies, job, loop, commandGroupAt(pipeline, position))
  if (config.kind === 'pull_request') return publish(dependencies, job, loop)
  return withLoop(dependencies, job, ['running'], async (unitOfWork, current) => {
    if (config.kind === 'ci' && current.step.pullRequestNumber === null)
      return endLoop(unitOfWork, current, finished(current.step, readyOutcomeOf(current.step)))
    if (config.kind === 'ci') {
      await saveLoop(unitOfWork, current, { ...current.step, state: 'waiting_for_ci' })
      return unitOfWork.devLoop.enqueue(devLoopJobTypes.ci, current.card.id, ciPollOf(dependencies))
    }
    const { baseBranch } = await unitOfWork.chats.get(current.card.chatId)
    const reviewing = { ...current.step, state: 'reviewing' as const, next: null, reportedFindings: null }
    return postLoopPrompt(
      unitOfWork,
      { ...current, step: reviewing },
      reviewing,
      reviewRequestOf(reviewing, baseBranch ?? ''),
      'review_request',
    )
  })
}

const judgeCommands = (dependencies: Dependencies, job: LoopJob, results: CheckResult[], head: string | null) =>
  withLoop(dependencies, job, ['running'], async (unitOfWork, loop) => {
    const group = commandGroupAt(loop.step.pipeline, loop.step.position)
    const failing = group.filter((_, offset) => results[offset]?.exitCode !== 0)
    const step = { ...loop.step, ...(head !== null && { checkedHead: head }) }
    const passing = group.filter((index) => !failing.includes(index))
    const judged = withOutcomes(
      step,
      passing.map((index) => [index, 'passed']),
    )
    if (failing.length === 0) return moveOn(unitOfWork, loop, judged, (group.at(-1) ?? loop.step.position) + 1)
    return sendBack(unitOfWork, { ...loop, step: judged }, failing, (rounds) =>
      checksFixPromptOf(
        results,
        new Map(
          failing.map((index) => {
            const config = judged.pipeline[index]
            return [
              config ? stepNameOf(config) : '',
              { round: rounds[index] ?? 1, limit: config && 'fixes' in config ? config.fixes : 0 },
            ]
          }),
        ),
      ),
    )
  })

const keepPolling = (dependencies: Dependencies, job: LoopJob, state: DevLoopStep['state'], every: number) =>
  withLoop(dependencies, job, [state], async () => ({ retryInMilliseconds: every }))

export const pollLoopChecks = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await loopIn(dependencies, job)
  if (loop?.step.state !== 'running') return undefined
  const endpoint = await endpointOfLoop(dependencies, loop)
  if (!endpoint)
    return withLoop(dependencies, job, ['running'], (unitOfWork, current) =>
      endLoop(unitOfWork, current, stopped(current.step, 'The checks stopped when the runtime stopped: over to you')),
    )
  const run = (await dependencies.agentClient
    .readWorkspace(endpoint, '/api/workspace/checks')
    .catch(() => undefined)) as ChecksRun | undefined
  if (run?.state === 'idle')
    return withLoop(dependencies, job, ['running'], (unitOfWork, current) =>
      endLoop(unitOfWork, current, stopped(current.step, 'The checks stopped when the runtime restarted: over to you')),
    )
  if (run && run.id !== loop.step.checksRunId) return runLoop(dependencies, job)
  if (run?.state !== 'finished') return keepPolling(dependencies, job, 'running', checksPollOf(dependencies))
  await judgeCommands(dependencies, job, run.results ?? [], await headOf(dependencies, loop, endpoint))
  return undefined
}

const ciRunsOf = async ({ checkouts }: Dependencies, loop: Loop) =>
  checkouts && loop.step.pullRequestNumber !== null
    ? checkouts.checkRunsOf(chatOf(loop), loop.step.pullRequestNumber)
    : undefined

export const judgeLoopCi = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await loopIn(dependencies, job)
  if (loop?.step.state !== 'waiting_for_ci') return undefined
  const config = loop.step.pipeline[loop.step.position]
  const counted = config?.kind === 'ci' ? config.checks : null
  const checks = await ciRunsOf(dependencies, loop).catch(() => undefined)
  const isCurrent = checks !== undefined && checks.headSha === loop.step.pushedHead
  const verdict = isCurrent ? ciVerdictOf(counted, checks.runs) : 'pending'
  const isQuiet = verdict === 'none' && Date.now() - (loop.step.publishedAt ?? 0) >= ciQuietMilliseconds
  const text =
    checks &&
    checkRunsTextOf(loop.step.pullRequestNumber ?? 0, { ...checks, runs: countedRunsOf(counted, checks.runs) })
  return withLoop(dependencies, job, ['waiting_for_ci'], async (unitOfWork, current) => {
    const { position } = current.step
    if (current.step.pushedHead !== loop.step.pushedHead) return undefined
    if (verdict === 'passing')
      return moveOn(unitOfWork, current, withOutcomes(current.step, [[position, 'passed']]), position + 1)
    if (isQuiet)
      return endLoop(unitOfWork, current, finished(current.step, noCiOutcomeOf(ciQuietMilliseconds / 60_000)))
    if (verdict === 'failing' && text)
      return sendBack(unitOfWork, current, [position], (rounds) =>
        ciFixPromptOf(text, rounds[position] ?? 1, failedAt(current.step, [position]).limit),
      )
    return { retryInMilliseconds: ciPollOf(dependencies) }
  })
}

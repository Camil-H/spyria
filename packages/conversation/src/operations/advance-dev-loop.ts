import { type MemberId, type MessageId, messageId, systemActor, type WorkspaceId } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
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
  countedRunsOf,
  type DevLoopPhase,
  type DevLoopPromptStep,
  type DevLoopStep,
  devLoopJobTypes,
  failedChecksOf,
  failedOnce,
  finished,
  handOffOutcomeOf,
  isActiveLoop,
  limitOutcomeOf,
  newFindingsOf,
  noCiOutcomeOf,
  pausedOutcome,
  readyOutcomeOf,
  reconsiderPromptOf,
  reviewFixPromptOf,
  reviewRequestOf,
  stopped,
} from '../domain/dev-loop.ts'
import { checkRunsTextOf } from '../domain/github-tools.ts'
import { type Message, newMessage } from '../domain/message.ts'
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
type ChecksRun = { state?: string; results?: CheckResult[]; ci?: string[] }

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

const sendBack = (
  unitOfWork: UnitOfWork,
  loop: Loop,
  phase: DevLoopPhase,
  promptOf: (round: number, limit: number) => string,
) => {
  const { round, limit, isOverLimit, rounds } = failedOnce(loop.step, phase)
  const step = { ...loop.step, rounds, next: null }
  return isOverLimit
    ? postLoopPrompt(
        unitOfWork,
        loop,
        { ...step, state: 'handing_off', outcome: handOffOutcomeOf(phase, limit) },
        reconsiderPromptOf(phase, limit),
        phase,
      )
    : postLoopPrompt(unitOfWork, loop, { ...step, state: 'working' }, promptOf(round, limit), phase)
}

const reviewOrPublish = async (unitOfWork: UnitOfWork, loop: Loop, step: DevLoopStep, baseBranch: string) => {
  if (step.limits.reviewRounds === 0) {
    await saveLoop(unitOfWork, loop, { ...step, state: 'publishing', next: null })
    return unitOfWork.devLoop.enqueue(devLoopJobTypes.publish, loop.card.id)
  }
  const reviewing = { ...step, state: 'reviewing' as const, next: null, reportedFindings: null }
  return postLoopPrompt(
    unitOfWork,
    { ...loop, step: reviewing },
    reviewing,
    reviewRequestOf(reviewing, baseBranch),
    'review_request',
  )
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

const lockedLoopOf = async (unitOfWork: UnitOfWork, loopId: MessageId) => {
  const card = await unitOfWork.messages.find(loopId)
  if (!card) return undefined
  await unitOfWork.agentTurns.lock(card.chatId)
  return loopOf(await unitOfWork.messages.find(loopId))
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
    const outcome = await limitOrBudgetOutcomeOf(dependencies, unitOfWork, loop)
    if (outcome) {
      await endLoop(unitOfWork, loop, stopped(loop.step, outcome))
      return undefined
    }
    return work(unitOfWork, loop)
  })

export const continueLoopAfterTurn = (dependencies: Dependencies, job: LoopJob) =>
  withLoop(dependencies, job, ['working', 'reviewing', 'handing_off'], async (unitOfWork, loop) => {
    const { step } = loop
    if (step.state === 'handing_off') return endLoop(unitOfWork, loop, stopped(step, step.outcome ?? pausedOutcome))
    if (step.state === 'working' && step.next === 'checks') {
      await saveLoop(unitOfWork, loop, { ...step, state: 'checking', next: null })
      return unitOfWork.devLoop.enqueue(devLoopJobTypes.checks, loop.card.id)
    }
    if (step.state === 'reviewing' && step.next === 'review_verdict') {
      const fresh = newFindingsOf(step, step.reportedFindings ?? [])
      const blocking = blockingFindingsOf(fresh)
      const reviewed = {
        ...step,
        findings: [...step.findings, ...fresh],
        reviewedHead: step.checkedHead,
        reportedFindings: null,
      }
      if (blocking.length === 0) {
        await saveLoop(unitOfWork, loop, { ...reviewed, state: 'publishing', next: null })
        return unitOfWork.devLoop.enqueue(devLoopJobTypes.publish, loop.card.id)
      }
      return sendBack(unitOfWork, { ...loop, step: reviewed }, 'review', (round, limit) =>
        reviewFixPromptOf(blocking, round, limit),
      )
    }
    return endLoop(unitOfWork, loop, stopped(step, pausedOutcome))
  })

const endpointOfLoop = async ({ runtimes }: Dependencies, loop: Loop | undefined) =>
  loop ? runtimes.endpointOf(chatOf(loop)) : undefined

export const startLoopChecks = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await dependencies.transactor.run(async ({ messages }) => loopOf(await messages.find(job.loopId)))
  if (loop?.step.state !== 'checking') return
  const endpoint = await endpointOfLoop(dependencies, loop)
  const started = endpoint
    ? await dependencies.agentClient.actOnWorkspace(endpoint, 'checks', {})
    : { failure: 'The runtime stopped before the checks ran: over to you' }
  if ('failure' in started)
    return withLoop(dependencies, job, ['checking'], (unitOfWork, current) =>
      endLoop(unitOfWork, current, stopped(current.step, String(started.failure))),
    )
  await dependencies.transactor.run(({ devLoop }) =>
    devLoop.enqueue(devLoopJobTypes.pollChecks, job.loopId, checksPollOf(dependencies)),
  )
}

const judgeChecks = (
  dependencies: Dependencies,
  job: LoopJob,
  { results = [], ci }: ChecksRun,
  checkedHead: string | null,
) =>
  withLoop(dependencies, job, ['checking'], async (unitOfWork, loop) => {
    const { baseBranch } = await unitOfWork.chats.get(loop.card.chatId)
    const step = {
      ...loop.step,
      checks: results.map(({ name, exitCode }) => ({ name, passed: exitCode === 0 })),
      ci: ci ?? null,
      checkedHead,
    }
    if (failedChecksOf(results).length > 0)
      return sendBack(unitOfWork, { ...loop, step }, 'checks', (round, limit) =>
        checksFixPromptOf(results, round, limit),
      )
    return reviewOrPublish(unitOfWork, { ...loop, step }, step, baseBranch ?? '')
  })

export const pollLoopChecks = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await dependencies.transactor.run(async ({ messages }) => loopOf(await messages.find(job.loopId)))
  if (loop?.step.state !== 'checking') return undefined
  const endpoint = await endpointOfLoop(dependencies, loop)
  const run = endpoint
    ? ((await dependencies.agentClient.readWorkspace(endpoint, '/api/workspace/checks')) as ChecksRun | undefined)
    : undefined
  if (run?.state === 'running') return { retryInMilliseconds: checksPollOf(dependencies) }
  if (run?.state !== 'finished' || !endpoint)
    return withLoop(dependencies, job, ['checking'], (unitOfWork, current) =>
      endLoop(unitOfWork, current, stopped(current.step, 'The checks stopped when the runtime stopped: over to you')),
    )
  const { baseBranch } = await dependencies.transactor.run(({ chats }) => chats.get(loop.card.chatId))
  const status = await dependencies.agentClient.readWorkspace(
    endpoint,
    agentWorkspacePathOf('status', '', baseBranch ?? ''),
  )
  await judgeChecks(dependencies, job, run, runtimeHeadsOf(status)[0] ?? null)
  return undefined
}

export const publishLoop = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await dependencies.transactor.run(async ({ messages }) => loopOf(await messages.find(job.loopId)))
  if (loop?.step.state !== 'publishing') return
  const published = await publishBranch(dependencies, {
    chat: chatOf(loop),
    actor: systemActor(devLoopActor, loop.ownerId),
    action: 'pull_request',
    draft: loop.step.summary,
  })
  await withLoop(dependencies, job, ['publishing'], async (unitOfWork, current) => {
    if (published.isRefused) return endLoop(unitOfWork, current, stopped(current.step, published.text))
    const card = await unitOfWork.messages.pullRequestCard(current.card.chatId)
    const pullRequest = card?.step?.type === 'pull_request' ? card.step : undefined
    const step = {
      ...current.step,
      pullRequestNumber: pullRequest?.number ?? null,
      pushedHead: pullRequest?.headSha ?? null,
      publishedAt: Date.now(),
    }
    if (step.limits.ciRounds === 0 || step.pullRequestNumber === null)
      return endLoop(unitOfWork, current, finished(step, readyOutcomeOf(step)))
    await saveLoop(unitOfWork, current, { ...step, state: 'waiting_for_ci' })
    await unitOfWork.devLoop.enqueue(devLoopJobTypes.ci, current.card.id, ciPollOf(dependencies))
  })
}

const ciRunsOf = async ({ checkouts }: Dependencies, loop: Loop) =>
  checkouts && loop.step.pullRequestNumber !== null
    ? checkouts.checkRunsOf(chatOf(loop), loop.step.pullRequestNumber)
    : undefined

export const judgeLoopCi = async (dependencies: Dependencies, job: LoopJob) => {
  const loop = await dependencies.transactor.run(async ({ messages }) => loopOf(await messages.find(job.loopId)))
  if (loop?.step.state !== 'waiting_for_ci') return undefined
  const checks = await ciRunsOf(dependencies, loop)
  const isCurrent = checks !== undefined && checks.headSha === loop.step.pushedHead
  const verdict = isCurrent ? ciVerdictOf(loop.step, checks.runs) : 'pending'
  const isQuiet = verdict === 'none' && Date.now() - (loop.step.publishedAt ?? 0) >= ciQuietMilliseconds
  const text =
    checks &&
    checkRunsTextOf(loop.step.pullRequestNumber ?? 0, { ...checks, runs: countedRunsOf(loop.step, checks.runs) })
  return withLoop(dependencies, job, ['waiting_for_ci'], async (unitOfWork, current) => {
    if (current.step.pushedHead !== loop.step.pushedHead) return undefined
    if (verdict === 'passing') return endLoop(unitOfWork, current, finished(current.step, readyOutcomeOf(current.step)))
    if (isQuiet)
      return endLoop(unitOfWork, current, finished(current.step, noCiOutcomeOf(ciQuietMilliseconds / 60_000)))
    if (verdict === 'failing' && text)
      return sendBack(unitOfWork, current, 'ci', (round, limit) => ciFixPromptOf(text, round, limit))
    return { retryInMilliseconds: ciPollOf(dependencies) }
  })
}

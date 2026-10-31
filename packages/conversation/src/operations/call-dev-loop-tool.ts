import { type DevLoopRules, type MemberId, messageId, rulesOf, systemActor } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { UnitOfWork } from '../contracts/transactor.ts'
import {
  devLoopInstructions,
  devLoopTools,
  findingsToVerifyOf,
  isActiveLoop,
  newDevLoop,
  reportReviewTool,
  reviewFindingsOf,
  unresolvedIdsOf,
} from '../domain/dev-loop.ts'
import { githubTools, githubToolsInstructions } from '../domain/github-tools.ts'
import type { ConversationChat } from '../domain/message.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { devLoopActor, type Loop, loopOfPrompt, saveLoop } from './dev-loop-turns.ts'

type Dependencies = Pick<AgentDependencies, 'transactor'>
type Input = { chat: AgentChat; memberId: MemberId; name: string; input: unknown }
type Turn = { chat: ConversationChat; prompt: Message; loop: Loop | undefined; rules: DevLoopRules }

const refused = (text: string) => ({ isRefused: true, text })
const answered = (text: string) => ({ isRefused: false, text })
const finishedWorkText =
  'Noted: once this turn ends, Spyria runs the checks and comes back to you if anything fails. End your turn now.'

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

const startLoop = async (unitOfWork: UnitOfWork, { chat, prompt, rules }: Turn, summary: Loop['step']['summary']) => {
  if (!prompt.authorId || prompt.authorId !== chat.ownerId || chat.isOwnerRemoved) {
    const ownerName = chat.ownerId ? await unitOfWork.members.displayNameOf(chat.ownerId) : 'the owner'
    return refused(`Only ${ownerName}'s prompts start quality gates: tell the members here that the work is done`)
  }
  await unitOfWork.messages.record({
    type: 'message.posted',
    actor: systemActor(devLoopActor, prompt.authorId),
    message: newMessage({
      id: messageId(crypto.randomUUID()),
      workspaceId: prompt.workspaceId,
      chatId: prompt.chatId,
      kind: 'step',
      authorId: prompt.authorId,
      body: MessageBody('dev_loop'),
      step: newDevLoop(prompt.id, prompt.createdAt.getTime(), chat.repository, rules, summary),
      createdAt: new Date(),
      replyToId: null,
    }),
  })
  return answered(finishedWorkText)
}

const finishWork = async (unitOfWork: UnitOfWork, turn: Turn, input: unknown) => {
  const parameters = (input ?? {}) as Record<string, unknown>
  const title = textOf(parameters.title).trim()
  if (!title) return refused('Give the pull request a title')
  const summary = { title, body: textOf(parameters.body) }
  const { loop, prompt } = turn
  if (!loop)
    return prompt.step?.type === 'dev_loop_prompt'
      ? refused('These quality gates have ended')
      : startLoop(unitOfWork, turn, summary)
  if (loop.step.state === 'reviewing' && loop.step.lastPromptId === prompt.id)
    return refused('This turn is for the review: call report_review with what the review found')
  if (!isActiveLoop(loop.step) || loop.step.lastPromptId !== prompt.id || loop.step.state !== 'working')
    return refused('These quality gates have ended: tell the owner the work is done')
  await saveLoop(unitOfWork, loop, { ...loop.step, next: 'run', summary })
  return answered(finishedWorkText)
}

const unresolvedRefusalOf = (step: Loop['step']) => {
  const ids = findingsToVerifyOf(step).map(({ id }) => id)
  return ids.length === 0
    ? 'No finding was given to check in this review: leave unresolved empty'
    : `Say which findings are not fixed: unresolved lists ids among ${ids.join(', ')}, or is empty when all are fixed`
}

const reportReview = async (unitOfWork: UnitOfWork, { loop, prompt }: Turn, input: unknown) => {
  if (!loop || loop.step.state !== 'reviewing' || loop.step.lastPromptId !== prompt.id)
    return refused('No review was asked for in this turn')
  const findings = reviewFindingsOf(input)
  if (!findings)
    return refused(
      'The findings are not valid: each needs a severity (important, nit or pre_existing), a path and a title, with at most 50 findings',
    )
  const unresolved = unresolvedIdsOf(input, loop.step)
  if (!unresolved) return refused(unresolvedRefusalOf(loop.step))
  await saveLoop(unitOfWork, loop, {
    ...loop.step,
    reportedFindings: findings,
    reportedUnresolved: unresolved,
    next: 'review_verdict',
  })
  return answered(`Recorded ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}. End your turn now.`)
}

export const callDevLoopTool = ({ transactor }: Dependencies, { chat, name, input }: Input) =>
  transactor.run(async (unitOfWork) => {
    const stored = await unitOfWork.chats.get(chat.chatId)
    if (!stored.baseBranch) return refused('This chat has no repository')
    const rules = rulesOf(await unitOfWork.devLoop.settings(), stored.repository)
    if (!rules.isOn) return refused('Quality gates are off for this repository')
    const promptId = await unitOfWork.agentTurns.lock(chat.chatId)
    if (!promptId) return refused('This runtime has no active turn')
    const prompt = await unitOfWork.messages.get(promptId)
    const turn = { chat: stored, prompt, loop: await loopOfPrompt(unitOfWork, prompt), rules }
    return name === reportReviewTool.name ? reportReview(unitOfWork, turn, input) : finishWork(unitOfWork, turn, input)
  })

export const githubToolsOf = ({ transactor }: Dependencies, chat: AgentChat) =>
  transactor.run(async ({ devLoop, chats }) => {
    const { baseBranch, repository } = await chats.get(chat.chatId)
    return baseBranch && rulesOf(await devLoop.settings(), repository).isOn
      ? { tools: [...githubTools, ...devLoopTools], instructions: `${githubToolsInstructions} ${devLoopInstructions}` }
      : { tools: githubTools, instructions: githubToolsInstructions }
  })

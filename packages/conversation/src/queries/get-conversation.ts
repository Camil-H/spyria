import { type ChatRow, findChat, type Snapshot } from '@hq/db'
import { type ChatId, type MemberId, type MessageId, messageId, type WorkspaceId } from '@hq/kernel'
import { stoppedByPrefix } from '../domain/agent-events.ts'
import type { AgentStep, StoredStep, ThoughtStep } from '../domain/agent-steps.ts'
import { stillRunningOf } from '../domain/delegation.ts'
import { type Harness, localSessions, type RunsOn, runsOnOf } from '../domain/session-routing.ts'

export type ConversationMessage = Readonly<{
  id: MessageId
  kind: 'member' | 'agent' | 'step' | 'notice'
  authorName: string
  createdAt: string
  body: string
  step: AgentStep | null
  replyToId: MessageId | null
  isOwn: boolean
  isDeleted: boolean
  isEdited: boolean
  isRunning: boolean
  canConnectTools: boolean
  delegation?: Readonly<{
    modelName: string
    steps: readonly ConversationMessage[]
    durationMilliseconds: number | null
    status: 'running' | 'finished' | 'failed' | 'stopped'
    result: string | null
    fallback?: string
  }>
}>

export type ConversationItem =
  | Readonly<{ type: 'message'; message: ConversationMessage }>
  | Readonly<{ type: 'fold'; promptId: MessageId; label: string; steps: readonly ConversationMessage[] }>

export type Conversation = Readonly<{
  title: string
  type: ChatRow['type']
  model: string | null
  reasoningEffort: ChatRow['reasoningEffort']
  defaultModel: ChatRow['defaultModel']
  subagentPolicy: ChatRow['subagentPolicy']
  harness: ChatRow['harness']
  localSession: boolean
  isPlanning: boolean
  runsOn: RunsOn | null
  isOwner: boolean
  runsOnChoices: readonly RunsOn[] | null
  gitBranch: string | null
  ownerName: string
  origin: Readonly<{ chatId: ChatId; name: string }> | null
  isAgentWorking: boolean
  hasActiveTurn: boolean
  messages: readonly ConversationMessage[]
  items: readonly ConversationItem[]
}>

export const durationLabelOf = (milliseconds: number) => {
  const seconds = milliseconds / 1000
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

const withThoughtsApart = (message: ConversationMessage): ConversationMessage[] => {
  const stored = message.step as StoredStep | null
  const isAnswer = message.kind === 'agent'
  const thought = isAnswer ? (stored as ThoughtStep | null) : stored?.thought
  if (!stored || !thought) return [message]
  const { thought: _, ...step } = stored
  return [
    {
      ...message,
      kind: 'step',
      id: messageId(`${message.id}-thought`),
      step: { ...thought, ...(stored.delegation && { delegation: stored.delegation }) } as AgentStep,
    },
    { ...message, step: isAnswer ? null : (step as AgentStep) },
  ]
}

const delegationOf = (message: ConversationMessage) => (message.step as StoredStep | null)?.delegation
const delegateArgumentsOf = (message: ConversationMessage) => {
  if (message.step?.type !== 'tool' || message.step.name !== 'delegate') return undefined
  try {
    return JSON.parse(message.step.arguments) as { task?: unknown; resume?: unknown }
  } catch {
    return undefined
  }
}

const withDelegationsGrouped = (replies: readonly ConversationMessage[], isStopped: boolean) => {
  const delegateActions = replies.filter((reply) => {
    const delegateArguments = delegateArgumentsOf(reply)
    return delegateArguments?.task !== undefined && !delegateArguments.resume
  })
  const groupsByHostId = new Map<MessageId, ConversationMessage>()
  const resumeIds = new Set<MessageId>()
  for (const steps of Map.groupBy(replies, (reply) => delegationOf(reply)?.id).values()) {
    const firstStep = steps[0]
    const delegation = firstStep && delegationOf(firstStep)
    if (!delegation) continue
    const actionIndex = delegateActions.findIndex((action) => delegateArgumentsOf(action)?.task === delegation.task)
    const host: ConversationMessage = replies.find((reply) => reply.id === delegation.id) ??
      delegateActions.splice(actionIndex, actionIndex < 0 ? 0 : 1)[0] ?? {
        ...firstStep,
        step: { type: 'tool', name: 'delegate', arguments: '', result: firstStep.isRunning ? null : '' },
      }
    const resumes = replies.filter((reply) => delegateArgumentsOf(reply)?.resume === delegation.id)
    for (const resume of resumes) resumeIds.add(resume.id)
    const lastStep = [host, ...resumes].at(-1)?.step
    const answered = lastStep?.type === 'tool' ? lastStep.result : null
    const result = answered === stillRunningOf(delegation.id) ? null : answered
    const isError = lastStep?.type === 'tool' && lastStep.isError === true
    const status =
      result === null
        ? host.isRunning
          ? 'running'
          : 'stopped'
        : isError
          ? isStopped
            ? 'stopped'
            : 'failed'
          : 'finished'
    const times = [host, ...steps, ...resumes].map((message) => Date.parse(message.createdAt))
    groupsByHostId.set(host.id, {
      ...host,
      delegation: {
        modelName: delegation.modelName,
        steps,
        durationMilliseconds: result === null ? null : Math.max(...times) - Math.min(...times),
        status,
        result,
        ...(delegation.fallback && { fallback: delegation.fallback }),
      },
    })
  }
  return replies.flatMap((reply) => {
    const group = groupsByHostId.get(reply.id)
    return group ? [group] : delegationOf(reply) || resumeIds.has(reply.id) ? [] : [reply]
  })
}

const turnItemsOf = (messages: readonly ConversationMessage[]): ConversationItem[] => {
  const repliesByPrompt = Map.groupBy(
    messages.filter((message) => message.replyToId !== null),
    (message) => message.replyToId as MessageId,
  )
  const itemsByStepId = new Map<MessageId, ConversationItem[]>()
  for (const [promptId, turnReplies] of repliesByPrompt) {
    const isStopped = turnReplies.some((reply) => reply.kind === 'notice' && reply.body.startsWith(stoppedByPrefix))
    const replies = withDelegationsGrouped(turnReplies, isStopped)
    const steps = replies.filter((reply) => reply.kind === 'step' && !(isStopped && reply.step?.type === 'error'))
    const plans = steps.filter((step) => step.step?.type === 'plan')
    const visibleSteps = steps
      .filter((step) => step.step?.type !== 'plan' || step === plans[0])
      .map((step) => (step === plans[0] ? { ...step, step: plans.at(-1)?.step ?? null } : step))
    const answer = replies.findLast((reply) => reply.kind === 'agent')
    const firstStep = visibleSteps[0]
    const firstStepIndex = replies.findIndex((reply) => reply.id === firstStep?.id)
    for (const reply of turnReplies) if (reply.kind === 'step') itemsByStepId.set(reply.id, [])
    if (
      answer &&
      firstStep &&
      replies.indexOf(answer) > firstStepIndex &&
      visibleSteps.length > 1 &&
      !firstStep.isRunning &&
      !isStopped &&
      !steps.some((step) => step.step?.type === 'error')
    ) {
      const workedFor = durationLabelOf(Date.parse(answer.createdAt) - Date.parse(firstStep.createdAt))
      const label = `Worked for ${workedFor} · ${visibleSteps.length} steps`
      const narration = replies.filter(
        (reply, index) => reply.kind === 'agent' && reply !== answer && index > firstStepIndex,
      )
      for (const reply of narration) itemsByStepId.set(reply.id, [])
      const folded = replies.flatMap(
        (reply) => visibleSteps.find((step) => step.id === reply.id) ?? (narration.includes(reply) ? [reply] : []),
      )
      itemsByStepId.set(firstStep.id, [{ type: 'fold', promptId, label, steps: folded }])
    } else for (const step of visibleSteps) itemsByStepId.set(step.id, [{ type: 'message', message: step }])
  }
  return messages.flatMap((message) => itemsByStepId.get(message.id) ?? [{ type: 'message', message }])
}

export const getConversation =
  (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId, hqRuntimeAvailable?: boolean) =>
  (snapshot: Snapshot): Conversation | null => {
    const chat = findChat(snapshot, workspaceId, chatId)
    if (!chat) return null
    const memberNames = new Map(
      snapshot.memberships
        .filter((membership) => membership.workspaceId === workspaceId)
        .map((membership) => [membership.memberId, membership.displayName]),
    )
    const memberName = (memberId: MemberId | null) => (memberId && memberNames.get(memberId)) || 'Agent'
    const origin = chat.originChatId ? findChat(snapshot, workspaceId, chat.originChatId) : undefined
    const chatMessages = snapshot.messages.filter((message) => message.chatId === chatId)
    const hasActiveTurn = chat.agentTurnMessageId !== null
    const isOwner = chat.ownerId === viewerId
    const machine = snapshot.workspaces.some((workspace) => workspace.id === workspaceId && workspace.localSessions)
      ? snapshot.runtimeHosts.find((host) => host.workspaceId === workspaceId && host.ownerId === viewerId)
      : undefined
    const connectedHarnesses = (Object.keys(localSessions) as Harness[]).filter(
      (harness) => machine?.status === 'online' && machine.capacity?.signedIn?.includes(localSessions[harness].signIn),
    )
    const isAdmin = snapshot.memberships.some(
      (member) => member.workspaceId === workspaceId && member.memberId === viewerId && member.role === 'admin',
    )
    const hasWorkspaceHost = isAdmin
      ? snapshot.runtimeHosts.some(
          (host) => host.workspaceId === workspaceId && host.ownerId === null && host.status === 'online',
        )
      : hqRuntimeAvailable
    const hasMachineSession = snapshot.runtimes.some((runtime) => runtime.chatId === chatId && runtime.hostOnline)
    const runsOnChoices =
      isOwner &&
      !hasActiveTurn &&
      !hasMachineSession &&
      (hasWorkspaceHost !== undefined || connectedHarnesses.length === 0) &&
      !chatMessages.some((message) => message.kind === 'agent' || message.kind === 'step')
        ? [...(hasWorkspaceHost || connectedHarnesses.length === 0 ? ['runtime' as const] : []), ...connectedHarnesses]
        : null
    const messages = chatMessages.map(
      (message): ConversationMessage => ({
        id: message.id,
        kind: message.kind,
        authorName: memberName(message.authorId),
        createdAt: message.createdAt,
        body: message.body,
        step: message.step as StoredStep | null,
        replyToId: message.replyToId,
        isOwn: message.authorId === viewerId,
        isDeleted: message.deletedAt !== null,
        isEdited: message.editedAt !== null,
        isRunning: hasActiveTurn && message.replyToId === chat.agentTurnMessageId,
        canConnectTools: chat.ownerId === viewerId,
      }),
    )
    return {
      title: chat.name,
      type: chat.type,
      model: chat.model,
      reasoningEffort: chat.reasoningEffort,
      defaultModel: chat.defaultModel,
      subagentPolicy: chat.subagentPolicy,
      harness: chat.harness,
      localSession: chat.localSession === true,
      isPlanning: chat.isPlanning,
      runsOn: runsOnOf(chat),
      isOwner,
      runsOnChoices,
      gitBranch: chat.gitBranch,
      ownerName: memberName(chat.ownerId),
      origin: origin ? { chatId: origin.id, name: origin.name } : null,
      isAgentWorking: hasActiveTurn || chatMessages.some((message) => message.needsReply),
      hasActiveTurn,
      messages,
      items: turnItemsOf(messages.flatMap(withThoughtsApart)),
    }
  }

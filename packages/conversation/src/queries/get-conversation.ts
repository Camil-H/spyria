import {
  type ChatRow,
  chatPermissionsIn,
  findChat,
  inChat,
  participantIn,
  type RuntimeOriginRow,
  type Snapshot,
} from '@hq/db'
import { type ChatId, can, type MemberId, type MessageId, messageId, type WorkspaceId } from '@hq/kernel'
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
  canEdit: boolean
  isDeleted: boolean
  isEdited: boolean
  isRunning: boolean
  canConnectTools: boolean
  canReply: boolean
  thread: Readonly<{ replies: readonly ConversationMessage[]; newCount: number }> | null
  runtimes: readonly RuntimeLink[]
  answeredByName?: string
  delegation?: Readonly<{
    id: string
    modelName: string
    steps: readonly ConversationMessage[]
    durationMilliseconds: number | null
    status: 'running' | 'finished' | 'failed' | 'stopped'
    result: string | null
    fallback?: string
    live?: Readonly<{ text: string; isReasoning: boolean }>
  }>
}>

export type RuntimeLink = Readonly<{ chatId: ChatId; startedByName: string; name: string | null }>

export type ConversationItem =
  | Readonly<{ type: 'message'; message: ConversationMessage }>
  | Readonly<{ type: 'fold'; promptId: MessageId; label: string; steps: readonly ConversationMessage[] }>

export type Conversation = Readonly<{
  title: string
  type: ChatRow['type']
  model: string | null
  reasoningEffort: ChatRow['reasoningEffort']
  subagentPolicy: ChatRow['subagentPolicy']
  harness: ChatRow['harness']
  localSession: boolean
  isPlanning: boolean
  runsOn: RunsOn | null
  isOwner: boolean
  canPost: boolean
  canJoin: boolean
  canConfigure: boolean
  runsOnChoices: readonly RunsOn[] | null
  gitBranch: string | null
  ownerName: string
  origin: Readonly<{ chatId: ChatId; name: string; type: 'channel' | 'runtime' }> | null
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
const routerArgumentsOf = (message: ConversationMessage, name: 'delegate' | 'await_task') => {
  if (message.step?.type !== 'tool' || message.step.name !== name) return undefined
  try {
    return JSON.parse(message.step.arguments) as { task?: unknown; taskId?: unknown }
  } catch {
    return undefined
  }
}

const withDelegationsGrouped = (replies: readonly ConversationMessage[], isStopped: boolean) => {
  const delegateActions = replies.filter((reply) => routerArgumentsOf(reply, 'delegate')?.task !== undefined)
  const groupsByHostId = new Map<MessageId, ConversationMessage>()
  const resumeIds = new Set<MessageId>()
  for (const steps of Map.groupBy(replies, (reply) => delegationOf(reply)?.id).values()) {
    const firstStep = steps[0]
    const delegation = firstStep && delegationOf(firstStep)
    if (!delegation) continue
    const actionIndex = delegateActions.findIndex(
      (action) => routerArgumentsOf(action, 'delegate')?.task === delegation.task,
    )
    const host: ConversationMessage = replies.find((reply) => reply.id === delegation.id) ??
      delegateActions.splice(actionIndex, actionIndex < 0 ? 0 : 1)[0] ?? {
        ...firstStep,
        step: { type: 'tool', name: 'delegate', arguments: '', result: firstStep.isRunning ? null : '' },
      }
    const resumes = replies.filter((reply) => routerArgumentsOf(reply, 'await_task')?.taskId === delegation.id)
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
        id: delegation.id,
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

export const isPlanSwitchIn = (messages: readonly ConversationMessage[]) => {
  const planToolCallSuffixes = messages.flatMap((message) =>
    message.step?.type === 'question' && message.step.kind === 'plan' && message.step.toolCallId
      ? [`:${message.step.toolCallId}`]
      : [],
  )
  return (message: ConversationMessage) =>
    message.step?.type === 'tool' && planToolCallSuffixes.some((suffix) => message.id.endsWith(suffix))
}

const turnItemsOf = (messages: readonly ConversationMessage[]): ConversationItem[] => {
  const repliesByPrompt = Map.groupBy(
    messages.filter((message) => message.replyToId !== null),
    (message) => message.replyToId as MessageId,
  )
  const itemsByStepId = new Map<MessageId, ConversationItem[]>()
  for (const [promptId, turnReplies] of repliesByPrompt) {
    const isStopped = turnReplies.some((reply) => reply.kind === 'notice' && reply.body.startsWith(stoppedByPrefix))
    const isPlanSwitch = isPlanSwitchIn(turnReplies)
    const replies = withDelegationsGrouped(
      turnReplies.filter((reply) => !isPlanSwitch(reply)),
      isStopped,
    )
    const steps = replies.filter(
      (reply) =>
        reply.kind === 'step' && reply.step?.type !== 'question' && !(isStopped && reply.step?.type === 'error'),
    )
    const plans = steps.filter((step) => step.step?.type === 'plan')
    const visibleSteps = steps
      .filter((step) => step.step?.type !== 'plan' || step === plans[0])
      .map((step) => (step === plans[0] ? { ...step, step: plans.at(-1)?.step ?? null } : step))
    const answer = replies.findLast((reply) => reply.kind === 'agent')
    const firstStep = visibleSteps[0]
    const firstStepIndex = replies.findIndex((reply) => reply.id === firstStep?.id)
    for (const reply of turnReplies) if (reply.kind === 'step') itemsByStepId.set(reply.id, [])
    for (const reply of replies)
      if (reply.step?.type === 'question') itemsByStepId.set(reply.id, [{ type: 'message', message: reply }])
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
    const permissions = chatPermissionsIn(snapshot, workspaceId, viewerId)(chat)
    const canPost = can(permissions, 'chat.post')
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
    const isChannel = chat.type === 'channel'
    const threadLastReadSeqOf = new Map(
      snapshot.threadReadMarkers
        .filter((marker) => marker.workspaceId === workspaceId && marker.memberId === viewerId)
        .map((marker) => [marker.threadRootId, marker.lastReadSeq]),
    )
    const repliesByRootId = Map.groupBy(
      chatMessages.filter((message) => message.threadRootId !== null),
      (message) => message.threadRootId,
    )
    const runtimesByMessageId = Map.groupBy(
      snapshot.runtimeOrigins.filter(inChat(workspaceId, chatId)),
      (origin) => origin.messageId,
    )
    const runtimeLinkOf = ({ runtimeChatId, startedBy }: RuntimeOriginRow): RuntimeLink => {
      const runtimeChat = findChat(snapshot, workspaceId, runtimeChatId)
      const canOpen = runtimeChat && can(chatPermissionsIn(snapshot, workspaceId, viewerId)(runtimeChat), 'chat.read')
      return { chatId: runtimeChatId, startedByName: memberName(startedBy), name: canOpen ? runtimeChat.name : null }
    }
    const conversationMessageOf = (message: (typeof chatMessages)[number]): ConversationMessage => {
      const step = message.step as StoredStep | null
      const replies = repliesByRootId.get(message.id) ?? []
      const isThreadRoot = isChannel && message.threadRootId === null
      return {
        id: message.id,
        kind: message.kind,
        authorName: memberName(message.authorId),
        createdAt: message.createdAt,
        body: message.body,
        step,
        replyToId: message.replyToId,
        canEdit: canPost && message.authorId === viewerId,
        isDeleted: message.deletedAt !== null,
        isEdited: message.editedAt !== null,
        isRunning: hasActiveTurn && message.replyToId === chat.agentTurnMessageId,
        canConnectTools: chat.ownerId === viewerId,
        canReply: isThreadRoot && canPost && message.deletedAt === null,
        thread: isThreadRoot
          ? {
              replies: replies.map(conversationMessageOf),
              newCount: replies.filter(
                (reply) =>
                  reply.seq > (threadLastReadSeqOf.get(message.id) ?? 0) &&
                  reply.authorId !== viewerId &&
                  reply.deletedAt === null,
              ).length,
            }
          : null,
        runtimes: (runtimesByMessageId.get(message.id) ?? []).map(runtimeLinkOf),
        ...(step?.type === 'question' &&
          step.answeredBy && { answeredByName: memberName(step.answeredBy as MemberId) }),
      }
    }
    const messages = chatMessages.filter((message) => message.threadRootId === null).map(conversationMessageOf)
    return {
      title: chat.name,
      type: chat.type,
      model: chat.model,
      reasoningEffort: chat.reasoningEffort,
      subagentPolicy: chat.subagentPolicy,
      harness: chat.harness,
      localSession: chat.localSession === true,
      isPlanning: chat.isPlanning,
      runsOn: runsOnOf(chat),
      isOwner,
      canPost,
      canJoin: chat.type === 'channel' && !participantIn(snapshot, workspaceId, viewerId)(chat),
      canConfigure: can(permissions, 'session.configure'),
      runsOnChoices,
      gitBranch: chat.gitBranch,
      ownerName: memberName(chat.ownerId),
      origin: origin ? { chatId: origin.id, name: origin.name, type: origin.type } : null,
      isAgentWorking: hasActiveTurn || chatMessages.some((message) => message.needsReply),
      hasActiveTurn,
      messages,
      items: turnItemsOf(messages.flatMap(withThoughtsApart)),
    }
  }

import { type ChatRow, findChat, type Snapshot } from '@hq/db'
import { type ChatId, type MemberId, type MessageId, messageId, type WorkspaceId } from '@hq/kernel'
import { stoppedByPrefix } from '../domain/agent-events.ts'
import type { AgentStep, StoredStep } from '../domain/agent-steps.ts'

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
}>

export type ConversationItem =
  | Readonly<{ type: 'message'; message: ConversationMessage }>
  | Readonly<{ type: 'fold'; promptId: MessageId; label: string; steps: readonly ConversationMessage[] }>

export type Conversation = Readonly<{
  title: string
  type: ChatRow['type']
  model: string | null
  reasoningEffort: ChatRow['reasoningEffort']
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
  if (!stored?.thought) return [message]
  const { thought, ...step } = stored
  return [
    { ...message, id: messageId(`${message.id}-thought`), step: thought },
    { ...message, step: step as AgentStep },
  ]
}

const turnItemsOf = (messages: readonly ConversationMessage[]): ConversationItem[] => {
  const repliesByPrompt = Map.groupBy(
    messages.filter((message) => message.replyToId !== null),
    (message) => message.replyToId as MessageId,
  )
  const itemsByStepId = new Map<MessageId, ConversationItem[]>()
  for (const [promptId, replies] of repliesByPrompt) {
    const isStopped = replies.some((reply) => reply.kind === 'notice' && reply.body.startsWith(stoppedByPrefix))
    const steps = replies.filter((reply) => reply.kind === 'step' && !(isStopped && reply.step?.type === 'error'))
    const plans = steps.filter((step) => step.step?.type === 'plan')
    const visibleSteps = steps
      .filter((step) => step.step?.type !== 'plan' || step === plans[0])
      .map((step) => (step === plans[0] ? { ...step, step: plans.at(-1)?.step ?? null } : step))
    const answer = replies.findLast((reply) => reply.kind === 'agent')
    const firstStep = visibleSteps[0]
    for (const reply of replies) if (reply.kind === 'step') itemsByStepId.set(reply.id, [])
    if (
      answer &&
      firstStep &&
      visibleSteps.length > 1 &&
      !firstStep.isRunning &&
      !isStopped &&
      !steps.some((step) => step.step?.type === 'error')
    ) {
      const workedFor = durationLabelOf(Date.parse(answer.createdAt) - Date.parse(firstStep.createdAt))
      const label = `Worked for ${workedFor} · ${visibleSteps.length} steps`
      itemsByStepId.set(firstStep.id, [{ type: 'fold', promptId, label, steps: visibleSteps }])
    } else for (const step of visibleSteps) itemsByStepId.set(step.id, [{ type: 'message', message: step }])
  }
  return messages.flatMap((message) => itemsByStepId.get(message.id) ?? [{ type: 'message', message }])
}

export const getConversation =
  (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) =>
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
      gitBranch: chat.gitBranch,
      ownerName: memberName(chat.ownerId),
      origin: origin ? { chatId: origin.id, name: origin.name } : null,
      isAgentWorking: hasActiveTurn || chatMessages.some((message) => message.needsReply),
      hasActiveTurn,
      messages,
      items: turnItemsOf(messages.flatMap(withThoughtsApart)),
    }
  }

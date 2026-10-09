import { type AgentEvent, agentProjectionOf, delegatedProjectionOf } from './agent-events.ts'
import { legacyToolCallStep, observedStep, type StepDelegation, type StoredStep } from './agent-steps.ts'
import type { Message } from './message.ts'

export type StoredEvent = Readonly<{
  workspaceId: string
  chatId: string
  id: string
  seq: number
  type: string
  actor: string | null
  payload: unknown
  createdAt: Date
}>

export type ProjectedMessage = Readonly<{
  workspaceId: string
  chatId: string
  id: string
  seq: number
  kind: Message['kind']
  authorId: string | null
  body: string
  detail: string | null
  step: StoredStep | null
  replyToId: string | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}>

export type PostedPayload = Pick<ProjectedMessage, 'body' | 'detail' | 'replyToId'> & {
  kind: ProjectedMessage['kind'] | 'tool-call'
  step?: StoredStep | null
}
export type ChangedPayload = { messageId: string; body: string }
export type AgentEventPayload = { replyToId: string | null; event: AgentEvent; delegation?: StepDelegation }

export const messagesFromEvents = (events: readonly StoredEvent[]): ProjectedMessage[] => {
  const messageByKey = new Map<string, ProjectedMessage>()
  const previousTimestampByChat = new Map<string, string>()
  for (const { workspaceId, chatId, id, seq, type, actor, payload, createdAt } of events) {
    const project = (fields: Pick<ProjectedMessage, 'kind' | 'authorId' | 'body' | 'detail' | 'step' | 'replyToId'>) =>
      messageByKey.set(`${workspaceId}/${id}`, {
        workspaceId,
        chatId,
        id,
        seq,
        ...fields,
        createdAt,
        editedAt: null,
        deletedAt: null,
      })
    if (type === 'message.posted' || type === 'message.replied') {
      const { kind, body, detail, replyToId, step = null } = payload as PostedPayload
      project(
        kind === 'tool-call'
          ? { kind: 'step', authorId: actor, body, detail, step: legacyToolCallStep(body, detail), replyToId }
          : { kind, authorId: actor, body, detail, step, replyToId },
      )
    }
    if (type === 'agent.event') {
      const { replyToId, event, delegation } = payload as AgentEventPayload
      const chatKey = `${workspaceId}/${chatId}`
      const projection = delegatedProjectionOf(
        agentProjectionOf(event, previousTimestampByChat.get(chatKey) ?? null),
        delegation,
      )
      previousTimestampByChat.set(chatKey, event.timestamp)
      if (projection?.type === 'observation') {
        const action = messageByKey.get(`${workspaceId}/${projection.actionId}`)
        const observed =
          action?.step &&
          observedStep(action.step, projection.observation, createdAt.getTime() - action.createdAt.getTime())
        if (action && observed) messageByKey.set(`${workspaceId}/${action.id}`, { ...action, step: observed })
      }
      if (projection?.type === 'message' || projection?.type === 'step') {
        const step = projection.type === 'step' ? projection.step : null
        const body = projection.type === 'step' ? projection.step.type : projection.body
        const kind = projection.type === 'step' ? 'step' : (projection.kind ?? 'agent')
        project({ kind, authorId: null, body, detail: null, step, replyToId })
      }
    }
    if (type !== 'message.edited' && type !== 'message.deleted') continue
    const { messageId, body } = payload as ChangedPayload
    const message = messageByKey.get(`${workspaceId}/${messageId}`)
    if (!message) continue
    messageByKey.set(
      `${workspaceId}/${messageId}`,
      type === 'message.edited'
        ? { ...message, body, editedAt: createdAt }
        : { ...message, body: '', deletedAt: createdAt },
    )
  }
  return [...messageByKey.values()]
}

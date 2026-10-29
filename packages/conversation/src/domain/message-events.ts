import { type Actor, actingMemberOf, memberBehind } from '@spyria/kernel'
import { type AgentEvent, agentProjectionOf, delegatedProjectionOf, observedProjectionStep } from './agent-events.ts'
import { legacyToolCallStep, type StepDelegation, type StoredStep } from './agent-steps.ts'
import type { Attachment } from './attachments.ts'
import type { Message } from './message.ts'

export type StoredEvent = Readonly<{
  workspaceId: string
  chatId: string
  id: string
  seq: number
  type: string
  actor: Actor
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
  attachments: readonly Attachment[]
  step: StoredStep | null
  replyToId: string | null
  threadRootId: string | null
  quotedMessageId: string | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}>

export type PostedPayload = Pick<ProjectedMessage, 'body' | 'replyToId'> & {
  detail?: string | null
  kind: ProjectedMessage['kind'] | 'tool-call'
  step?: StoredStep | null
  threadRootId?: string
  quotedMessageId?: string
  attachments?: readonly Attachment[]
}
export type ChangedPayload = { messageId: string; body: string }
export type StepChangedPayload = { messageId: string; step: StoredStep }
export type AgentEventPayload = {
  replyToId: string | null
  event: AgentEvent
  delegation?: StepDelegation
}

export const messagesFromEvents = (events: readonly StoredEvent[]): ProjectedMessage[] => {
  const messageByKey = new Map<string, ProjectedMessage>()
  for (const { workspaceId, chatId, id, seq, type, actor, payload, createdAt } of events) {
    const project = (
      fields: Pick<ProjectedMessage, 'kind' | 'authorId' | 'body' | 'step' | 'replyToId'> &
        Partial<Pick<ProjectedMessage, 'threadRootId' | 'quotedMessageId' | 'attachments'>>,
      projectedId = id,
    ) =>
      messageByKey.set(`${workspaceId}/${projectedId}`, {
        workspaceId,
        chatId,
        id: projectedId,
        seq,
        threadRootId: null,
        quotedMessageId: null,
        attachments: [],
        ...fields,
        createdAt,
        editedAt: null,
        deletedAt: null,
      })
    if (type === 'message.posted' || type === 'message.replied') {
      const {
        kind,
        body,
        detail,
        replyToId,
        step = null,
        threadRootId = null,
        quotedMessageId = null,
        attachments = [],
      } = payload as PostedPayload
      project(
        kind === 'tool-call'
          ? { kind: 'step', authorId: actingMemberOf(actor), body, step: legacyToolCallStep(body, detail), replyToId }
          : {
              kind,
              authorId: kind === 'notice' ? null : memberBehind(actor),
              body,
              attachments,
              step,
              replyToId,
              threadRootId,
              quotedMessageId,
            },
      )
    }
    if (type === 'agent.event') {
      const { replyToId, event, delegation } = payload as AgentEventPayload
      const projection = delegatedProjectionOf(agentProjectionOf(event), delegation)
      if (projection?.type === 'observation') {
        const action = messageByKey.get(`${workspaceId}/${projection.actionId}`)
        const observed =
          action?.step &&
          observedProjectionStep(action.step, projection, createdAt.getTime() - action.createdAt.getTime())
        if (action && observed) messageByKey.set(`${workspaceId}/${action.id}`, { ...action, step: observed })
      }
      if (projection?.type === 'message' || projection?.type === 'step') {
        const step = projection.type === 'step' ? projection.step : (projection.thought ?? null)
        const body = projection.type === 'step' ? projection.step.type : projection.body
        const kind = projection.type === 'step' ? 'step' : (projection.kind ?? 'agent')
        project({ kind, authorId: null, body, step, replyToId }, (projection.type === 'step' && projection.id) || id)
      }
    }
    if (type === 'message.step_changed') {
      const { messageId, step } = payload as StepChangedPayload
      const message = messageByKey.get(`${workspaceId}/${messageId}`)
      if (message) messageByKey.set(`${workspaceId}/${messageId}`, { ...message, step })
    }
    if (type !== 'message.edited' && type !== 'message.deleted') continue
    const { messageId, body } = payload as ChangedPayload
    const message = messageByKey.get(`${workspaceId}/${messageId}`)
    if (!message) continue
    messageByKey.set(
      `${workspaceId}/${messageId}`,
      type === 'message.edited'
        ? { ...message, body, editedAt: createdAt }
        : { ...message, body: '', attachments: [], deletedAt: createdAt },
    )
  }
  return [...messageByKey.values()]
}

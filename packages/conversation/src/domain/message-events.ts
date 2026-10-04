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
  replyToId: string | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}>

type PostedPayload = Pick<ProjectedMessage, 'kind' | 'body' | 'detail' | 'replyToId'>
type ChangedPayload = { messageId: string; body: string }

export const messagesFromEvents = (events: readonly StoredEvent[]): ProjectedMessage[] => {
  const messageByKey = new Map<string, ProjectedMessage>()
  for (const { workspaceId, chatId, id, seq, type, actor, payload, createdAt } of events) {
    if (type === 'message.posted' || type === 'message.replied') {
      const { kind, body, detail, replyToId } = payload as PostedPayload
      messageByKey.set(`${workspaceId}/${id}`, {
        workspaceId,
        chatId,
        id,
        seq,
        kind,
        authorId: actor,
        body,
        detail,
        replyToId,
        createdAt,
        editedAt: null,
        deletedAt: null,
      })
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

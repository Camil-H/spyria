import type { ServerTransaction } from '@rocicorp/zero'

export type ChatEvent = {
  workspaceId: string
  chatId: string
  type: string
  actor: string | null
  payload: object
  createdAt: Date
  id?: string
}

export const appendChatEvent = async (tx: ServerTransaction, { workspaceId, chatId, ...event }: ChatEvent) => {
  const query = async (statement: string, parameters: unknown[]) => [
    ...(await tx.dbTransaction.query(statement, parameters)),
  ]
  const lockedChats = await query('select 1 from chats where workspace_id = $1 and id = $2 for update', [
    workspaceId,
    chatId,
  ])
  if (lockedChats.length === 0) throw new Error(`Chat ${chatId} was not found`)
  const [appended] = await query(
    `insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
     select $1, $2, $3::text, coalesce(max(seq), 0) + 1, $4::text, $5::text, $6::jsonb, $7::timestamptz
     from events where workspace_id = $1 and chat_id = $2
     returning seq`,
    [
      workspaceId,
      chatId,
      event.id ?? crypto.randomUUID(),
      event.type,
      event.actor,
      JSON.stringify(event.payload),
      event.createdAt.toISOString(),
    ],
  )
  return Number((appended as { seq: number }).seq)
}

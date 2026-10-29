import type { ServerTransaction } from '@rocicorp/zero'
import { messagesFromEvents, type ProjectedMessage } from '../domain/message-events.ts'

type EventRow = {
  workspace_id: string
  chat_id: string
  id: string
  seq: number
  type: string
  actor: string | null
  payload: unknown
  created_at_milliseconds: string
}

const updatedColumns =
  'chat_id, seq, kind, author_id, body, attachments, detail, reply_to_id, thread_root_id, quoted_message_id, created_at, edited_at, deleted_at'
const inScope = (chatColumn: string) =>
  `workspace_id = coalesce($1::text, workspace_id) and ${chatColumn} = coalesce($2::text, ${chatColumn})`
const snakeCased = (message: ProjectedMessage) =>
  Object.fromEntries(
    Object.entries(message).map(([key, value]) => [
      key.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  )

export const rebuildMessages = async (
  tx: ServerTransaction,
  { workspaceId = null, chatId = null }: { workspaceId?: string | null; chatId?: string | null } = {},
) => {
  const query = async (statement: string, parameters: unknown[]) => [
    ...(await tx.dbTransaction.query(statement, parameters)),
  ]
  const scope = [workspaceId, chatId]
  await query(`select 1 from chats where ${inScope('id')} order by workspace_id, id for update`, scope)
  const eventRows = (await query(
    `select workspace_id, chat_id, id, seq, type, actor, payload,
       extract(epoch from created_at) * 1000 as created_at_milliseconds
     from events where ${inScope('chat_id')} order by workspace_id, chat_id, seq`,
    scope,
  )) as EventRow[]
  const messages = messagesFromEvents(
    eventRows.map((row) => ({
      workspaceId: row.workspace_id,
      chatId: row.chat_id,
      id: row.id,
      seq: row.seq,
      type: row.type,
      actor: row.actor,
      payload: row.payload,
      createdAt: new Date(Number(row.created_at_milliseconds)),
    })),
  )
  await query(
    `delete from messages where ${inScope('chat_id')} and not (workspace_id || '/' || id = any($3::text[]))`,
    [...scope, messages.map((message) => `${message.workspaceId}/${message.id}`)],
  )
  await query(
    `insert into messages select * from jsonb_populate_recordset(null::messages, $1::jsonb)
     on conflict (workspace_id, id) do update set (${updatedColumns}) =
       row(${updatedColumns.replaceAll(/\w+/g, (column) => `excluded.${column}`)})`,
    [JSON.stringify(messages.map(snakeCased))],
  )
  return messages.length
}

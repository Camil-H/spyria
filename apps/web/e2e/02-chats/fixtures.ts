import type { Locator, Page } from '@playwright/test'
import { chatLinkOf, sidebarOf } from '../fixtures.ts'
import type { WorkerStack } from '../stack.ts'

export * from '../fixtures.ts'

export const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
export const chatRowIn = (group: Locator, chatName: string) => group.getByRole('link', { name: chatName })
export const draftIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Has unsent draft' })

export type PostedMessage = {
  id: string
  body: string
  kind?: 'member' | 'agent' | 'notice'
  authorId?: string | null
  createdAt?: string
}
export const numberedMessages = (idPrefix: string, bodyPrefix: string, count: number, createdAt?: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}${index + 1}`,
    body: `${bodyPrefix}${index + 1}`,
    createdAt,
  }))
export const postMessages = (workerStack: WorkerStack, chatId: string, messages: PostedMessage[]) => {
  const rows = messages.map((message, index) => ({
    id: message.id,
    body: message.body,
    kind: message.kind ?? 'member',
    author_id: message.authorId === undefined ? 'member-alice' : message.authorId,
    created_at: message.createdAt ?? null,
    number: index + 1,
  }))
  return workerStack.database.$client.begin(async (sql) => {
    await sql`select 1 from chats where id = ${chatId} for update`
    await sql`
      with posted_messages as (
        select posted.id, posted.kind, posted.author_id, posted.body,
          coalesce(posted.created_at, now()) as created_at,
          greatest(
            (select coalesce(max(seq), 0) from events where chat_id = ${chatId}),
            (select coalesce(max(seq), 0) from messages where chat_id = ${chatId})
          ) + posted.number as seq
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          as posted(id text, kind text, author_id text, body text, created_at timestamptz, number int)
      ), posted_events as (
        insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
        select 'workspace-acme', ${chatId}, id, seq, 'message.posted', author_id,
          jsonb_build_object('kind', kind, 'body', body, 'replyToId', null), created_at
        from posted_messages
      )
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      select 'workspace-acme', ${chatId}, id, seq, kind, author_id, body, created_at from posted_messages`
  })
}

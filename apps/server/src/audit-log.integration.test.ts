import { beforeEach, expect, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { schema } from '@spyria/db/zero'
import { workspaceId } from '@spyria/kernel'
import { auditJobs } from '@spyria/usage/server'
import {
  acme,
  alice,
  asMember,
  bob,
  globex,
  inviteToAcme,
  lee,
  newChat,
  openSharedTestApp,
  sendTo,
  sessionTokenOf,
  succeeded,
  workspaceEventsOf,
} from './testing/testing.ts'

const { database, app, resultOf } = await openSharedTestApp()
const sql = database.$client
const dayMilliseconds = 24 * 3_600_000
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
const daysAgo = (days: number) => new Date(Date.now() - days * dayMilliseconds)

type AuditEntry = {
  key: string
  at: string
  person: string
  action: string
  target: string
  details: { label: string; value: string }[]
}
type AuditPage = { entries: AuditEntry[]; nextCursor: string | null }

const auditPageOf = async (search: Record<string, string> = {}, userId = alice) => {
  const response = await asMember(userId, 'GET', `/api/audit-log?${new URLSearchParams(search)}`)
  expect(response.status).toBe(200)
  return JSON.parse(response.body) as AuditPage
}
const summaryOf = ({ person, action, target }: AuditEntry) => `${person} | ${action} | ${target}`
const detailsOf = (entry: AuditEntry | undefined) =>
  Object.fromEntries((entry?.details ?? []).map(({ label, value }) => [label, value]))

const insertWorkspaceEvent = (
  id: string,
  type: string,
  actorId: string | null,
  payload: object,
  at: Date,
  workspace: string = acme,
) =>
  sql`insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
      values (${workspace}, ${id}, ${type}, ${actorId}, ${JSON.stringify(payload)}::jsonb, ${at.toISOString()}::timestamptz)`
const insertToolCall = (
  id: string,
  at: Date,
  fields: Partial<Record<'prompter_id' | 'decision' | 'decided_by', string>> = {},
) =>
  sql`insert into tool_calls (workspace_id, chat_id, id, prompter_id, owner_id, server, tool, read_only, decision, decided_by, status, called_at)
      values (${acme}, 'chat-research', ${id}, ${fields.prompter_id ?? bob}, ${alice}, 'crm', 'update', false,
        ${fields.decision ?? 'approved'}, ${fields.decided_by ?? alice}, 'succeeded', ${at.toISOString()}::timestamptz)`
const insertChatEvent = (chatId: string, id: string, type: string, actor: string | null, payload: object, at: Date) =>
  sql`insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      select ${acme}, ${chatId}, ${id}, coalesce(max(seq), 0) + 1, ${type}, ${actor}, ${JSON.stringify(payload)}::jsonb, ${at.toISOString()}::timestamptz
      from events where workspace_id = ${acme} and chat_id = ${chatId}`
const pullRequestStep = (state: string) => ({
  type: 'pull_request',
  repository: 'acme/app',
  number: 7,
  url: 'https://github.com/acme/app/pull/7',
  title: 'Fix the invoice total',
  state,
})

beforeEach(async () => {
  await openSharedTestApp()
})

test('only active admins read the audit log, its CSV and its retention; members get 403', async () => {
  for (const [method, path] of [
    ['GET', '/api/audit-log'],
    ['GET', '/api/audit-log/csv'],
    ['GET', '/api/audit-log/retention'],
    ['POST', '/api/audit-log/retention'],
  ] as const) {
    const refused = await asMember(bob, method, path, method === 'POST' ? { retentionDays: 1 } : undefined)
    expect({ path, status: refused.status, body: JSON.parse(refused.body) }).toEqual({
      path,
      status: 403,
      body: {
        error: 'missing_workspace_permission',
        message: 'Your workspace role does not allow this: View the audit log',
      },
    })
  }
  expect((await sql`select * from audit_settings`).length).toBe(0)
  expect((await asMember(alice, 'GET', '/api/audit-log/retention')).status).toBe(200)
})

test('workspace events, chat events, tool calls, pushes and pull requests merge newest first, with names and no message bodies', async () => {
  const privateChat = await newChat({ ownerId: bob, type: 'channel', visibility: 'private' })
  await sql`update chats set name = 'Bob private' where id = ${privateChat}`
  await sendTo(
    { workspaceId: acme, userId: bob },
    privateChat,
    crypto.randomUUID(),
    'the secret body of a private message',
  )
  await insertChatEvent(
    privateChat,
    'pull-request',
    'message.posted',
    bob,
    { kind: 'step', body: 'pull_request', replyToId: null, step: pullRequestStep('open') },
    minutesAgo(9),
  )
  await insertChatEvent(
    privateChat,
    'checks',
    'message.step_changed',
    null,
    { messageId: 'pull-request', step: pullRequestStep('open') },
    minutesAgo(8),
  )
  await insertChatEvent(
    privateChat,
    'merged',
    'message.step_changed',
    null,
    { messageId: 'pull-request', step: pullRequestStep('merged') },
    minutesAgo(7),
  )
  await insertChatEvent(
    privateChat,
    'pushed',
    'branch.pushed',
    bob,
    { branch: 'spyria/fix', head: 'abc123' },
    minutesAgo(10),
  )
  await insertToolCall('call', minutesAgo(6))
  expect(await inviteToAcme(app, database, 'nina@example.com')).toEqual(succeeded)
  expect(
    await resultOf({ workspaceId: acme, userId: bob }, 'conversation.inviteMember', {
      workspaceId: acme,
      chatId: privateChat,
      memberId: lee,
      roleId: 'reader',
    }),
  ).toEqual(succeeded)

  const { entries, nextCursor } = await auditPageOf()
  expect(nextCursor).toBeNull()
  expect(entries.map(summaryOf)).toEqual([
    'Bob | Added a member to a chat | Bob private',
    'Alice | Invited a member | nina@example.com',
    'Bob | Called a tool | crm · update',
    'System | Merged a pull request | acme/app#7',
    'Bob | Opened a pull request | acme/app#7',
    'Bob | Pushed a branch | Bob private',
  ])
  expect(entries.map((entry) => entry.at)).toEqual(
    entries
      .map((entry) => entry.at)
      .toSorted()
      .reverse(),
  )
  expect(detailsOf(entries[0])).toEqual({ Member: 'Lee', Role: 'Reader' })
  expect(detailsOf(entries[1])).toEqual({ Email: 'nina@example.com', Role: 'Member' })
  expect(detailsOf(entries[2])).toEqual({
    Chat: 'Research',
    Server: 'crm',
    Tool: 'update',
    'Read only': 'No',
    Decision: 'approved',
    'Decided by': 'Alice',
    Owner: 'Alice',
    Status: 'succeeded',
  })
  expect(detailsOf(entries[3])).toMatchObject({ Chat: 'Bob private', State: 'merged', Title: 'Fix the invoice total' })
  expect(detailsOf(entries[5])).toEqual({ Branch: 'spyria/fix', Head: 'abc123' })
  const csv = await asMember(alice, 'GET', '/api/audit-log/csv')
  expect([...(await sql`select body from messages where chat_id = ${privateChat} and kind = 'member'`)]).toEqual([
    { body: 'the secret body of a private message' },
  ])
  expect(JSON.stringify(entries) + csv.body).not.toContain('secret body')
})

test('a deleted message shows its text to audit readers only, never in the synced message or its deletion event, until the sweep erases it', async () => {
  const privateChat = await newChat({ ownerId: bob, type: 'channel', visibility: 'private' })
  await sql`update chats set name = 'Bob private' where id = ${privateChat}`
  const messageId = crypto.randomUUID()
  await sendTo({ workspaceId: acme, userId: bob }, privateChat, messageId, 'the staging password is hunter2')
  expect(
    await resultOf({ workspaceId: acme, userId: bob }, 'conversation.deleteMessage', { workspaceId: acme, messageId }),
  ).toEqual(succeeded)

  const [entry] = (await auditPageOf({ group: 'Chats' })).entries
  expect(entry && summaryOf(entry)).toBe('Bob | Deleted a message | Bob private')
  expect(detailsOf(entry)).toEqual({ Chat: 'Bob private', Text: 'the staging password is hunter2' })
  expect((await asMember(bob, 'GET', '/api/audit-log')).status).toBe(403)
  expect([...(await sql`select body from messages where id = ${messageId}`)]).toEqual([{ body: '' }])
  expect([
    ...(await sql`select payload from events where chat_id = ${privateChat} and type = 'message.deleted'`),
  ]).toEqual([{ payload: { messageId } }])

  await sql`update deleted_message_texts set deleted_at = now() - interval '31 days' where message_id = ${messageId}`
  await asMember(alice, 'POST', '/api/audit-log/retention', { retentionDays: 30 })
  await zeroDrizzle(schema, database).transaction((tx) =>
    auditJobs['audit.sweep']({ workspaceId: workspaceId(acme), transact: (work) => work(tx) }),
  )
  expect([...(await sql`select body from deleted_message_texts where message_id = ${messageId}`)]).toEqual([])
})

test('pages follow a keyset cursor without gaps or repeats, also between rows of the same instant', async () => {
  const sameInstant = minutesAgo(25.5)
  for (let index = 0; index < 70; index++)
    await insertWorkspaceEvent(
      `event-${String(index).padStart(2, '0')}`,
      'member.invited',
      alice,
      { email: `m${index}@example.com` },
      index < 20 ? sameInstant : minutesAgo(index),
    )
  for (let index = 0; index < 5; index++) await insertToolCall(`call-${index}`, sameInstant)
  const first = await auditPageOf()
  expect(first.entries).toHaveLength(50)
  const second = await auditPageOf({ cursor: first.nextCursor ?? '' })
  expect(second.nextCursor).toBeNull()
  const keys = [...first.entries, ...second.entries].map((entry) => entry.key)
  expect(keys).toHaveLength(75)
  expect(new Set(keys).size).toBe(75)
  const sameInstantKeys = [
    ...Array.from({ length: 20 }, (_, index) => `w:event-${String(index).padStart(2, '0')}`),
    ...Array.from({ length: 5 }, (_, index) => `t:call-${index}`),
  ]
    .toSorted()
    .reverse()
  const keyOfMinute = (minute: number) => `w:event-${String(minute).padStart(2, '0')}`
  expect(keys).toEqual([
    ...Array.from({ length: 6 }, (_, index) => keyOfMinute(20 + index)),
    ...sameInstantKeys,
    ...Array.from({ length: 44 }, (_, index) => keyOfMinute(26 + index)),
  ])
  expect((await asMember(alice, 'GET', '/api/audit-log?cursor=nonsense')).status).toBe(400)
})

test('filters by person, grouped type and date range, and the CSV holds the same filtered rows', async () => {
  await insertWorkspaceEvent(
    'invite',
    'member.invited',
    alice,
    { email: 'nina@example.com', role: 'member' },
    minutesAgo(5),
  )
  await insertWorkspaceEvent('sso', 'sso.configured', alice, { issuer: 'https://login.example.com' }, minutesAgo(4))
  await insertWorkspaceEvent('old-removal', 'member.removed', alice, { memberId: bob }, daysAgo(3))
  await insertToolCall('bobs-call', minutesAgo(3))
  await insertWorkspaceEvent('globex', 'member.invited', alice, { email: 'globex@example.com' }, minutesAgo(2), globex)

  expect((await auditPageOf({ person: alice })).entries.map(summaryOf)).toEqual([
    'Alice | Configured SSO | https://login.example.com',
    'Alice | Invited a member | nina@example.com',
    'Alice | Removed a member | Bob',
  ])
  expect((await auditPageOf({ person: alice, group: 'Members' })).entries.map(summaryOf)).toEqual([
    'Alice | Invited a member | nina@example.com',
    'Alice | Removed a member | Bob',
  ])
  const sinceYesterday = {
    group: 'Members',
    from: daysAgo(1).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  }
  expect((await auditPageOf(sinceYesterday)).entries.map(summaryOf)).toEqual([
    'Alice | Invited a member | nina@example.com',
  ])
  expect((await auditPageOf({ group: 'Tool calls' })).entries.map(summaryOf)).toEqual([
    'Bob | Called a tool | crm · update',
  ])
  expect((await asMember(alice, 'GET', '/api/audit-log?group=Everything')).status).toBe(400)

  const response = await app.request(`/api/audit-log/csv?${new URLSearchParams({ person: alice, group: 'Members' })}`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
  })
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="audit-log.csv"')
  const [header, ...rows] = (await response.text()).trimEnd().split('\n')
  expect(header).toBe('Time,Person,Action,Target,Details')
  const page = await auditPageOf({ person: alice, group: 'Members' })
  expect(rows).toEqual(
    page.entries.map((entry) =>
      [
        entry.at,
        entry.person,
        entry.action,
        entry.target,
        entry.details.map(({ label, value }) => `${label}: ${value}`).join('; '),
      ].join(','),
    ),
  )
  expect(rows[0]).toBe(
    `${page.entries[0]?.at},Alice,Invited a member,nina@example.com,Role: Member; Email: nina@example.com`,
  )
})

test('retention defaults to forever, a change is audited, and the daily sweep deletes only expired workspace events and tool calls', async () => {
  expect(JSON.parse((await asMember(alice, 'GET', '/api/audit-log/retention')).body)).toEqual({ retentionDays: null })
  const refused = await asMember(alice, 'POST', '/api/audit-log/retention', { retentionDays: 0 })
  expect({ status: refused.status, body: JSON.parse(refused.body) }).toEqual({
    status: 400,
    body: { error: 'invalid_retention', message: 'Keep audit records forever or for 1 to 36500 days' },
  })
  const saved = await asMember(alice, 'POST', '/api/audit-log/retention', { retentionDays: 30 })
  expect(JSON.parse(saved.body)).toEqual({ retentionDays: 30 })
  await asMember(alice, 'POST', '/api/audit-log/retention', { retentionDays: 30 })
  expect(await workspaceEventsOf(database)).toEqual([
    { type: 'audit.retention_changed', actorId: alice, payload: { retentionDays: 30 } },
  ])
  expect((await auditPageOf()).entries.map(summaryOf)).toEqual([
    'Alice | Changed how long audit records are kept | 30 days',
  ])

  await insertWorkspaceEvent('old', 'member.invited', alice, { email: 'old@example.com' }, daysAgo(31))
  await insertWorkspaceEvent('recent', 'member.invited', alice, { email: 'recent@example.com' }, daysAgo(29))
  await insertWorkspaceEvent('globex-old', 'member.invited', alice, { email: 'g@example.com' }, daysAgo(31), globex)
  await insertToolCall('old-call', daysAgo(31))
  await insertToolCall('recent-call', daysAgo(28))
  await insertChatEvent(
    'chat-research',
    'old-chat-event',
    'member.joined',
    bob,
    { memberId: bob, roleId: 'prompter' },
    daysAgo(31),
  )
  await insertChatEvent(
    'chat-research',
    'recent-chat-event',
    'member.joined',
    bob,
    { memberId: bob, roleId: 'prompter' },
    daysAgo(27),
  )
  expect((await auditPageOf()).entries.map((entry) => entry.key)).not.toContain('c:old-chat-event')

  await zeroDrizzle(schema, database).transaction((tx) =>
    auditJobs['audit.sweep']({ workspaceId: workspaceId(acme), transact: (work) => work(tx) }),
  )
  expect(
    (await sql`select id from workspace_events where id in ('old', 'globex-old', 'recent') order by id`).map(
      (row) => row.id,
    ),
  ).toEqual(['globex-old', 'recent'])
  expect((await sql`select id from tool_calls order by id`).map((row) => row.id)).toEqual(['recent-call'])
  expect(
    (await sql`select id from events where id in ('old-chat-event', 'recent-chat-event') order by id`).map(
      (row) => row.id,
    ),
  ).toEqual(['old-chat-event', 'recent-chat-event'])
  expect([
    ...(await sql`select type, state, run_at > now() + interval '23 hours' as "isTomorrow" from jobs where type = 'audit.sweep' and workspace_id = ${acme}`),
  ]).toEqual([{ type: 'audit.sweep', state: 'queued', isTomorrow: true }])
  expect((await auditPageOf()).entries.map((entry) => entry.key)).toEqual([
    expect.stringMatching(/^w:/),
    'c:recent-chat-event',
    't:recent-call',
    'w:recent',
  ])
})

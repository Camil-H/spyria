import type { ServerTransaction, Transaction } from '@rocicorp/zero'

const onServer = async (tx: Transaction, statement: string, parameters: unknown[]) =>
  tx.location === 'server' ? [...(await tx.dbTransaction.query(statement, parameters))] : []

export const insertLlmCredential = (
  tx: Transaction,
  credential: { workspaceId: string; id: string; userId: string; provider: string; last4: string; secretRef: string },
) =>
  onServer(
    tx,
    'insert into llm_credentials (workspace_id, id, user_id, provider, last4, secret_ref) values ($1, $2, $3, $4, $5, $6)',
    [
      credential.workspaceId,
      credential.id,
      credential.userId,
      credential.provider,
      credential.last4,
      credential.secretRef,
    ],
  )

export const secretRefOfLlmCredential = async (tx: Transaction, workspaceId: string, id: string) => {
  const [stored] = await onServer(tx, 'select secret_ref from llm_credentials where workspace_id = $1 and id = $2', [
    workspaceId,
    id,
  ])
  return (stored as { secret_ref: string } | undefined)?.secret_ref
}

export const keepPlaceholderSecret = (tx: Transaction, workspaceId: string, ref: string, value: string) =>
  onServer(tx, 'insert into placeholder_secrets (workspace_id, ref, value) values ($1, $2, $3)', [
    workspaceId,
    ref,
    value,
  ])

export const discardPlaceholderSecret = (tx: Transaction, workspaceId: string, ref: string) =>
  onServer(tx, 'delete from placeholder_secrets where workspace_id = $1 and ref = $2', [workspaceId, ref])

export const placeholderSecretOf = async (tx: Transaction, workspaceId: string, ref: string) =>
  (
    (await onServer(tx, 'select value from placeholder_secrets where workspace_id = $1 and ref = $2', [
      workspaceId,
      ref,
    ])) as { value: string }[]
  )[0]?.value

export const lockMembership = (tx: Transaction, workspaceId: string, userId: string) =>
  onServer(tx, 'select 1 from memberships where workspace_id = $1 and user_id = $2 for update', [workspaceId, userId])

export const enqueueJob = (
  tx: Transaction,
  job: { workspaceId: string; type: string; payload: object; delayMilliseconds: number },
) =>
  onServer(
    tx,
    `insert into jobs (workspace_id, id, type, payload, run_at, attempts, state) values ($1, $2, $3, $4::jsonb, now() + make_interval(secs => $5::double precision / 1000), 0, 'queued') on conflict do nothing`,
    [job.workspaceId, crypto.randomUUID(), job.type, JSON.stringify(job.payload), job.delayMilliseconds],
  )

const secretHashColumns = { claimCode: 'claim_code_hash', token: 'token_hash' }
type RuntimeHostSecret = keyof typeof secretHashColumns
type RuntimeHostKey = { workspaceId: string; id: string }

export const setRuntimeHostSecretHash = (
  tx: Transaction,
  host: RuntimeHostKey,
  secret: RuntimeHostSecret,
  hash: string,
) =>
  onServer(tx, `update runtime_hosts set ${secretHashColumns[secret]} = $3 where workspace_id = $1 and id = $2`, [
    host.workspaceId,
    host.id,
    hash,
  ])

export const lockRuntimeHost = (tx: Transaction, workspaceId: string, id: string) =>
  onServer(tx, 'select 1 from runtime_hosts where workspace_id = $1 and id = $2 for update', [workspaceId, id])

export const findRuntimeHostBySecretHash = async (tx: Transaction, secret: RuntimeHostSecret, hash: string) =>
  (
    await onServer(
      tx,
      `select workspace_id as "workspaceId", id, token_hash is not null as claimed from runtime_hosts where ${secretHashColumns[secret]} = $1 for update`,
      [hash],
    )
  )[0] as (RuntimeHostKey & { claimed: boolean }) | undefined

const runtimeLocks = {
  id: 'id = $2 for update',
  chat: 'chat_id = $2 for update',
  host: "host_id = $2 and state <> 'removed' for update",
  sweepable: "state in ('running', 'stopped') for update skip locked",
}

export const lockRuntimes = async (
  tx: Transaction,
  workspaceId: string,
  scope: keyof typeof runtimeLocks,
  key?: string,
) => {
  if (scope === 'chat')
    await onServer(tx, 'select 1 from chats where workspace_id = $1 and id = $2 for update', [workspaceId, key])
  const rows = await onServer(
    tx,
    `select id from runtimes where workspace_id = $1 and ${runtimeLocks[scope]}`,
    key === undefined ? [workspaceId] : [workspaceId, key],
  )
  return (rows as { id: string }[]).map((row) => row.id)
}

export const lockRuntimeHostLoads = async (tx: Transaction, workspaceId: string) =>
  (await onServer(
    tx,
    `select id as "hostId", status = 'online' as online, coalesce((capacity->>'cap')::int, 0) as cap,
       (select count(*)::int from runtimes where runtimes.workspace_id = runtime_hosts.workspace_id
          and runtimes.host_id = runtime_hosts.id and runtimes.state in ('creating', 'starting', 'running', 'stopping')
       ) as running
     from runtime_hosts where workspace_id = $1 and removed_at is null for update`,
    [workspaceId],
  )) as { hostId: string; online: boolean; cap: number; running: number }[]

const serverOnlyRuntimeColumns = {
  apiKey: 'api_key_ref',
  llmToken: 'llm_token_ref',
  agentConversation: 'agent_conversation_id',
}
export type ServerOnlyRuntimeColumn = keyof typeof serverOnlyRuntimeColumns

export const serverOnlyRuntimeValueOf = async (
  tx: Transaction,
  workspaceId: string,
  runtimeId: string,
  column: ServerOnlyRuntimeColumn,
) =>
  (
    (await onServer(
      tx,
      `select ${serverOnlyRuntimeColumns[column]} as value from runtimes where workspace_id = $1 and id = $2`,
      [workspaceId, runtimeId],
    )) as { value: string | null }[]
  )[0]?.value ?? undefined

export const setServerOnlyRuntimeValue = (
  tx: Transaction,
  workspaceId: string,
  runtimeId: string,
  column: ServerOnlyRuntimeColumn,
  value: string | null,
) =>
  onServer(tx, `update runtimes set ${serverOnlyRuntimeColumns[column]} = $3 where workspace_id = $1 and id = $2`, [
    workspaceId,
    runtimeId,
    value,
  ])

export const rememberAgentConversation = async (
  tx: Transaction,
  workspaceId: string,
  runtimeId: string,
  conversationId: string,
) =>
  (
    (await onServer(
      tx,
      `update runtimes set agent_conversation_id = coalesce(agent_conversation_id, $3)
       where workspace_id = $1 and id = $2 returning agent_conversation_id as id`,
      [workspaceId, runtimeId, conversationId],
    )) as { id: string | null }[]
  )[0]?.id ?? conversationId

export const lockChatTurn = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    (await onServer(
      tx,
      `select agent_turn_message_id as "turnMessageId" from chats where workspace_id = $1 and id = $2 for update`,
      [workspaceId, chatId],
    )) as { turnMessageId: string | null }[]
  )[0]?.turnMessageId ?? null

export const pendingPrompts = async (
  tx: Transaction,
  workspaceId: string,
  chatId: string,
  waitingNoticeBodies: readonly string[],
) =>
  (
    (await onServer(
      tx,
      `select prompt.id from messages prompt join chats on chats.workspace_id = prompt.workspace_id and chats.id = prompt.chat_id
       where prompt.workspace_id = $1 and prompt.chat_id = $2 and prompt.kind = 'member' and prompt.reply_to_id is null
         and prompt.deleted_at is null and prompt.id is distinct from chats.agent_turn_message_id
         and not exists (select 1 from messages reply where reply.workspace_id = prompt.workspace_id and reply.reply_to_id = prompt.id
           and not (reply.kind = 'notice' and reply.body = any($3::text[])))
       order by prompt.seq`,
      [workspaceId, chatId, waitingNoticeBodies],
    )) as { id: string }[]
  ).map((prompt) => prompt.id)

export const activeAgentTurns = async (tx: Transaction, workspaceId: string) =>
  (await onServer(
    tx,
    `select id as "chatId", agent_turn_message_id as "promptId",
       (select extract(epoch from max(created_at)) * 1000 from events
        where events.workspace_id = chats.workspace_id and events.chat_id = chats.id)::float8 as "lastEventAt"
     from chats where workspace_id = $1 and agent_turn_message_id is not null`,
    [workspaceId],
  )) as { chatId: string; promptId: string; lastEventAt: number }[]

export const setRuntimesHostOnline = (tx: Transaction, workspaceId: string, hostId: string, isOnline: boolean) =>
  onServer(tx, 'update runtimes set host_online = $3 where workspace_id = $1 and host_id = $2 and host_online <> $3', [
    workspaceId,
    hostId,
    isOnline,
  ])

export const isChatEventStored = async (tx: Transaction, workspaceId: string, eventId: string) =>
  (await onServer(tx, 'select 1 from events where workspace_id = $1 and id = $2', [workspaceId, eventId])).length > 0

export const lastAgentEvent = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    (await onServer(
      tx,
      `select payload->'event'->>'timestamp' as timestamp, payload->>'replyToId' as "replyToId" from events
       where workspace_id = $1 and chat_id = $2 and type = 'agent.event' order by seq desc limit 1`,
      [workspaceId, chatId],
    )) as { timestamp: string; replyToId: string | null }[]
  )[0]

export const agentObservationOf = async (tx: Transaction, workspaceId: string, chatId: string, actionId: string) =>
  (
    (await onServer(
      tx,
      `select payload->'event'->'observation' as observation from events
       where workspace_id = $1 and chat_id = $2 and type = 'agent.event' and payload->'event'->>'action_id' = $3`,
      [workspaceId, chatId, actionId],
    )) as { observation: Record<string, unknown> }[]
  )[0]?.observation

type ChatEvent = {
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

import { type ListedModel, providersOfGatewayRefs, reachableModelsOf } from '@hq/kernel'
import type { ServerTransaction, Transaction } from '@rocicorp/zero'

const onServer = async <Row = unknown>(tx: Transaction, statement: string, parameters: unknown[]) =>
  (tx.location === 'server' ? [...(await tx.dbTransaction.query(statement, parameters))] : []) as Row[]
const firstOnServer = async <Row>(tx: Transaction, statement: string, parameters: unknown[]) =>
  (await onServer<Row>(tx, statement, parameters))[0]

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

const credentialRefs = 'select secret_ref as ref from llm_credentials where workspace_id = $1'

export const gatewayKeyRefsOf = async (tx: Transaction, workspaceId: string, userId: string) =>
  (await onServer<{ ref: string }>(tx, `${credentialRefs} and user_id = $2`, [workspaceId, userId])).map(
    (row) => row.ref,
  )

export const gatewayKeyRefOf = async (tx: Transaction, workspaceId: string, id: string) =>
  (await firstOnServer<{ ref: string }>(tx, `${credentialRefs} and id = $2`, [workspaceId, id]))?.ref

export const virtualKeyIdOf = async (tx: Transaction, workspaceId: string, userId: string) =>
  (
    await firstOnServer<{ id: string }>(
      tx,
      'select virtual_key_id as id from member_gateway_keys where workspace_id = $1 and user_id = $2',
      [workspaceId, userId],
    )
  )?.id

let listedModels: () => readonly ListedModel[] = () => []
export const setModelDirectory = (directory: typeof listedModels) => {
  listedModels = directory
}
export const listedModelsOf = () => listedModels()
export const memberModelsOf = async (tx: Transaction, workspaceId: string, userId: string) =>
  tx.location === 'server'
    ? reachableModelsOf(providersOfGatewayRefs(await gatewayKeyRefsOf(tx, workspaceId, userId)))
    : undefined

export const setVirtualKeyId = (tx: Transaction, workspaceId: string, userId: string, id: string | null) =>
  id === null
    ? onServer(tx, 'delete from member_gateway_keys where workspace_id = $1 and user_id = $2', [workspaceId, userId])
    : onServer(
        tx,
        `insert into member_gateway_keys (workspace_id, user_id, virtual_key_id) values ($1, $2, $3)
         on conflict (workspace_id, user_id) do update set virtual_key_id = excluded.virtual_key_id`,
        [workspaceId, userId, id],
      )

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

export const findRuntimeHostBySecretHash = (tx: Transaction, secret: RuntimeHostSecret, hash: string) =>
  firstOnServer<RuntimeHostKey & { claimed: boolean }>(
    tx,
    `select workspace_id as "workspaceId", id, token_hash is not null as claimed from runtime_hosts where ${secretHashColumns[secret]} = $1 for update`,
    [hash],
  )

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
  const rows = await onServer<{ id: string }>(
    tx,
    `select id from runtimes where workspace_id = $1 and ${runtimeLocks[scope]}`,
    key === undefined ? [workspaceId] : [workspaceId, key],
  )
  return rows.map((row) => row.id)
}

export const lockRuntimeHostLoads = (tx: Transaction, workspaceId: string) =>
  onServer<{ hostId: string; online: boolean; cap: number; running: number }>(
    tx,
    `select id as "hostId", status = 'online' as online, coalesce((capacity->>'cap')::int, 0) as cap,
       (select count(*)::int from runtimes where runtimes.workspace_id = runtime_hosts.workspace_id
          and runtimes.host_id = runtime_hosts.id and runtimes.state in ('creating', 'starting', 'running', 'stopping')
       ) as running
     from runtime_hosts where workspace_id = $1 and removed_at is null for update`,
    [workspaceId],
  )

const serverOnlyRuntimeColumns = {
  apiKey: 'api_key',
  llmTokenHash: 'llm_token_hash',
  llmSwitchTokenHash: 'llm_switch_token_hash',
  agentConversation: 'agent_conversation_id',
}
type ServerOnlyRuntimeColumn = keyof typeof serverOnlyRuntimeColumns

export const serverOnlyRuntimeValueOf = async (
  tx: Transaction,
  workspaceId: string,
  runtimeId: string,
  column: ServerOnlyRuntimeColumn,
) =>
  (
    await firstOnServer<{ value: string | null }>(
      tx,
      `select ${serverOnlyRuntimeColumns[column]} as value from runtimes where workspace_id = $1 and id = $2`,
      [workspaceId, runtimeId],
    )
  )?.value ?? undefined

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
    await firstOnServer<{ id: string | null }>(
      tx,
      `update runtimes set agent_conversation_id = coalesce(agent_conversation_id, $3)
       where workspace_id = $1 and id = $2 returning agent_conversation_id as id`,
      [workspaceId, runtimeId, conversationId],
    )
  )?.id ?? conversationId

export const lockChatTurn = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    await firstOnServer<{ turnMessageId: string | null }>(
      tx,
      `select agent_turn_message_id as "turnMessageId" from chats where workspace_id = $1 and id = $2 for update`,
      [workspaceId, chatId],
    )
  )?.turnMessageId ?? null

export const setChatTurnPrompter = (tx: Transaction, workspaceId: string, chatId: string, prompterId: string | null) =>
  onServer(
    tx,
    `update chats set agent_turn_prompter_id = $3, agent_turn_failure = case when $3::text is null then agent_turn_failure end
     where workspace_id = $1 and id = $2`,
    [workspaceId, chatId, prompterId],
  )

export const chatTurnOf = (tx: Transaction, workspaceId: string, chatId: string) =>
  firstOnServer<{ promptId: string | null; prompterId: string | null; ownerId: string | null; failure: string | null }>(
    tx,
    `select agent_turn_message_id as "promptId", agent_turn_prompter_id as "prompterId", owner_user_id as "ownerId",
       agent_turn_failure as failure
     from chats where workspace_id = $1 and id = $2`,
    [workspaceId, chatId],
  )

export const setChatTurnFailure = (
  tx: Transaction,
  workspaceId: string,
  chatId: string,
  promptId: string,
  failure: string,
) =>
  onServer(
    tx,
    'update chats set agent_turn_failure = $4 where workspace_id = $1 and id = $2 and agent_turn_message_id = $3',
    [workspaceId, chatId, promptId, failure],
  )

export const runtimeChatOfLlmTokenHash = async (tx: Transaction, workspaceId: string, hostId: string, hash: string) =>
  (
    await firstOnServer<{ chatId: string }>(
      tx,
      'select chat_id as "chatId" from runtimes where workspace_id = $1 and host_id = $2 and $3 in (llm_token_hash, llm_switch_token_hash)',
      [workspaceId, hostId, hash],
    )
  )?.chatId

export const pendingPrompts = async (
  tx: Transaction,
  workspaceId: string,
  chatId: string,
  waitingNoticeBodies: readonly string[],
) =>
  (
    await onServer<{ id: string }>(
      tx,
      `select prompt.id from messages prompt join chats on chats.workspace_id = prompt.workspace_id and chats.id = prompt.chat_id
       where prompt.workspace_id = $1 and prompt.chat_id = $2 and prompt.kind = 'member' and prompt.reply_to_id is null
         and prompt.deleted_at is null and prompt.id is distinct from chats.agent_turn_message_id
         and not exists (select 1 from messages reply where reply.workspace_id = prompt.workspace_id and reply.reply_to_id = prompt.id
           and not (reply.kind = 'notice' and reply.body = any($3::text[])))
       order by prompt.seq`,
      [workspaceId, chatId, waitingNoticeBodies],
    )
  ).map((prompt) => prompt.id)

export const activeAgentTurns = (tx: Transaction, workspaceId: string) =>
  onServer<{ chatId: string; promptId: string; lastEventAt: number }>(
    tx,
    `select id as "chatId", agent_turn_message_id as "promptId",
       (select extract(epoch from max(created_at)) * 1000 from events
        where events.workspace_id = chats.workspace_id and events.chat_id = chats.id)::float8 as "lastEventAt"
     from chats where workspace_id = $1 and agent_turn_message_id is not null`,
    [workspaceId],
  )

export const setRuntimesHostOnline = (tx: Transaction, workspaceId: string, hostId: string, isOnline: boolean) =>
  onServer(tx, 'update runtimes set host_online = $3 where workspace_id = $1 and host_id = $2 and host_online <> $3', [
    workspaceId,
    hostId,
    isOnline,
  ])

export const isChatEventStored = async (tx: Transaction, workspaceId: string, eventId: string) =>
  (await onServer(tx, 'select 1 from events where workspace_id = $1 and id = $2', [workspaceId, eventId])).length > 0

export const lastAgentEvent = (tx: Transaction, workspaceId: string, chatId: string) =>
  firstOnServer<{ timestamp: string; replyToId: string | null }>(
    tx,
    `select payload->'event'->>'timestamp' as timestamp, payload->>'replyToId' as "replyToId" from events
     where workspace_id = $1 and chat_id = $2 and type = 'agent.event' order by seq desc limit 1`,
    [workspaceId, chatId],
  )

export const agentObservationOf = async (tx: Transaction, workspaceId: string, chatId: string, actionId: string) =>
  (
    await firstOnServer<{ observation: Record<string, unknown> }>(
      tx,
      `select payload->'event'->'observation' as observation from events
       where workspace_id = $1 and chat_id = $2 and type = 'agent.event' and payload->'event'->>'action_id' = $3`,
      [workspaceId, chatId, actionId],
    )
  )?.observation

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

export const chatRoutingOf = (tx: Transaction, workspaceId: string, chatId: string) =>
  firstOnServer<{
    mode: string | null
    ownerId: string | null
    model: string | null
    reasoningEffort: string | null
    defaultModel: string | null
    agentModel: string | null
    subagentPolicy: string
  }>(
    tx,
    `select mode, owner_user_id as "ownerId", model, reasoning_effort as "reasoningEffort",
       default_model as "defaultModel", agent_model as "agentModel", subagent_policy as "subagentPolicy"
     from chats where workspace_id = $1 and id = $2`,
    [workspaceId, chatId],
  )

export const setChatAgentModel = (tx: Transaction, workspaceId: string, chatId: string, model: string) =>
  onServer(tx, 'update chats set agent_model = $3 where workspace_id = $1 and id = $2', [workspaceId, chatId, model])

const insertServerOnlyRow = (tx: Transaction, table: string, row: Record<string, unknown>) =>
  onServer(tx, `insert into ${table} select * from jsonb_populate_record(null::${table}, $1::jsonb)`, [
    JSON.stringify(
      Object.fromEntries(
        Object.entries({ id: crypto.randomUUID(), createdAt: new Date(), ...row }).map(([name, value]) => [
          name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          value,
        ]),
      ),
    ),
  ])

export const insertRoutingDecision = (tx: Transaction, decision: Record<string, unknown>) =>
  insertServerOnlyRow(tx, 'routing_decisions', decision)

export const insertDelegation = (tx: Transaction, delegation: Record<string, unknown>) =>
  insertServerOnlyRow(tx, 'delegations', delegation)

export const setDelegationFields = (
  tx: Transaction,
  workspaceId: string,
  id: string,
  fields: { conversationId?: string; status?: string },
) =>
  onServer(
    tx,
    `update delegations set conversation_id = coalesce($3, conversation_id), status = coalesce($4, status),
       finished_at = case when $4::text is null then finished_at else now() end
     where workspace_id = $1 and id = $2 and status = 'running'`,
    [workspaceId, id, fields.conversationId ?? null, fields.status ?? null],
  )

export const runningDelegationOfTokenHash = (tx: Transaction, workspaceId: string, hostId: string, hash: string) =>
  firstOnServer<{ chatId: string; id: string }>(
    tx,
    `select delegations.chat_id as "chatId", delegations.id from delegations join runtimes
       on runtimes.workspace_id = delegations.workspace_id and runtimes.chat_id = delegations.chat_id
     where delegations.workspace_id = $1 and runtimes.host_id = $2 and delegations.token_hash = $3
       and delegations.status = 'running'`,
    [workspaceId, hostId, hash],
  )

export const unansweredDelegateAction = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    await firstOnServer<{ id: string }>(
      tx,
      `select id from events action where workspace_id = $1 and chat_id = $2 and type = 'agent.event'
         and payload->'event'->>'kind' = 'ActionEvent' and payload->'event'->>'tool_name' in ('delegate', 'router_delegate')
         and not exists (select 1 from events observation where observation.workspace_id = $1
           and observation.chat_id = $2 and observation.payload->'event'->>'action_id' = action.id)
       order by seq desc limit 1`,
      [workspaceId, chatId],
    )
  )?.id

export const chatModelCalls = async (tx: Transaction, workspaceId: string, chatId: string) => ({
  models: await onServer<{ model: string; calls: number; tokens: number; costMicros: number }>(
    tx,
    `select provider || '/' || model as model, count(*)::int as calls,
       sum(input_tokens + output_tokens)::int as tokens, sum(cost_micros)::int as "costMicros"
     from model_calls where workspace_id = $1 and chat_id = $2 group by 1 order by min(called_at)`,
    [workspaceId, chatId],
  ),
  latest: await firstOnServer<{ tokens: number }>(
    tx,
    `select input_tokens + output_tokens as tokens from model_calls
     where workspace_id = $1 and chat_id = $2 and role is null order by called_at desc limit 1`,
    [workspaceId, chatId],
  ),
})

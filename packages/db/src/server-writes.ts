import { context, propagation } from '@opentelemetry/api'
import type { ServerTransaction, Transaction } from '@rocicorp/zero'
import { type HarnessId, type ListedModel, providersOfGatewayRefs, reachableModelsOf } from '@spyria/kernel'

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

export const virtualKeyIdsIn = (tx: Transaction, workspaceId: string) =>
  onServer<{ memberId: string; virtualKeyId: string }>(
    tx,
    `select user_id as "memberId", virtual_key_id as "virtualKeyId" from member_gateway_keys
     join memberships using (workspace_id, user_id) where workspace_id = $1 and removed_at is null`,
    [workspaceId],
  )

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
  onServer(tx, 'select 1 from memberships where workspace_id = $1 and user_id = $2 and removed_at is null for update', [
    workspaceId,
    userId,
  ])

export const lockActiveAdminIds = async (tx: Transaction, workspaceId: string) =>
  (
    await onServer<{ userId: string }>(
      tx,
      `select user_id as "userId" from memberships where workspace_id = $1 and role = 'admin' and removed_at is null
       order by user_id for update`,
      [workspaceId],
    )
  ).map((row) => row.userId)

export const deleteMemberSessions = (tx: Transaction, workspaceId: string, userId: string) =>
  onServer(tx, 'delete from sessions where workspace_id = $1 and user_id = $2', [workspaceId, userId])

export const deleteGitHubConnection = (tx: Transaction, workspaceId: string, userId: string) =>
  onServer(tx, 'delete from github_connections where workspace_id = $1 and user_id = $2', [workspaceId, userId])

export const appendWorkspaceEvent = (
  tx: Transaction,
  event: { workspaceId: string; type: string; actorId: string; payload: object },
) =>
  onServer(
    tx,
    'insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)',
    [
      event.workspaceId,
      crypto.randomUUID(),
      event.type,
      event.actorId,
      JSON.stringify(event.payload),
      new Date().toISOString(),
    ],
  )

export const copyWorkspaceSignIn = async (
  tx: Transaction,
  { fromWorkspaceId, toWorkspaceId, userId }: { fromWorkspaceId: string; toWorkspaceId: string; userId: string },
) => {
  const [provider] = await onServer<{ preset: string; issuer: string; clientId: string }>(
    tx,
    `insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, uses_instance_app, updated_at)
     select $2, preset, issuer, client_id, encrypted_client_secret, uses_instance_app, now() from workspace_sso where workspace_id = $1
     returning preset, issuer, client_id as "clientId"`,
    [fromWorkspaceId, toWorkspaceId],
  )
  if (!provider) return
  const [copied] = await onServer<{ domain: string }>(
    tx,
    `insert into sso_domains (workspace_id, domain, verified_at)
     select $2, domain, verified_at from sso_domains
     where workspace_id = $1 and domain = (select split_part(email, '@', 2) from users where id = $3)
     returning domain`,
    [fromWorkspaceId, toWorkspaceId, userId],
  )
  await appendWorkspaceEvent(tx, {
    workspaceId: toWorkspaceId,
    type: 'sso.configured',
    actorId: userId,
    payload: { ...provider, domain: copied?.domain },
  })
}

export const awaitsDomainVerification = async (tx: Transaction, workspaceId: string) =>
  (
    await firstOnServer<{ awaits: boolean }>(
      tx,
      `select exists(select 1 from workspace_sso where workspace_id = $1)
         and not exists(select 1 from sso_domains where workspace_id = $1 and verified_at is not null) as awaits`,
      [workspaceId],
    )
  )?.awaits ?? false

const traceContextOf = (delayMilliseconds: number) => {
  const carrier: Record<string, string> = {}
  if (delayMilliseconds === 0) propagation.inject(context.active(), carrier)
  return carrier
}

export const enqueueJob = (
  tx: Transaction,
  job: { workspaceId: string; type: string; payload: object; delayMilliseconds: number },
) =>
  onServer(
    tx,
    `insert into jobs (workspace_id, id, type, payload, run_at, attempts, state) values ($1, $2, $3, $4::jsonb, now() + make_interval(secs => $5::double precision / 1000), 0, 'queued') on conflict do nothing`,
    [
      job.workspaceId,
      crypto.randomUUID(),
      job.type,
      JSON.stringify({ ...job.payload, ...traceContextOf(job.delayMilliseconds) }),
      job.delayMilliseconds,
    ],
  )

const secretHashColumns = { claimCode: 'claim_code_hash', token: 'token_hash' }
type RuntimeHostSecret = keyof typeof secretHashColumns
type RuntimeHostKey = { workspaceId: string; id: string }

export const setRuntimeHostSecretHash = (
  tx: Transaction,
  host: RuntimeHostKey,
  secret: RuntimeHostSecret,
  hash: string | null,
) =>
  onServer(tx, `update runtime_hosts set ${secretHashColumns[secret]} = $3 where workspace_id = $1 and id = $2`, [
    host.workspaceId,
    host.id,
    hash,
  ])

export const lockRuntimeHost = (tx: Transaction, workspaceId: string, id: string) =>
  onServer(tx, 'select 1 from runtime_hosts where workspace_id = $1 and id = $2 for update', [workspaceId, id])

export const refreshMachineCounts = async (tx: Transaction, workspaceId: string) => {
  await onServer(
    tx,
    'insert into machine_counts (workspace_id, machines, claude_code, codex) values ($1, 0, 0, 0) on conflict do nothing',
    [workspaceId],
  )
  await onServer(tx, 'select 1 from machine_counts where workspace_id = $1 for update', [workspaceId])
  await onServer(
    tx,
    `with counted as (
       select count(*)::int as machines, count(*) filter (where capacity->'signedIn' ? 'claude-code')::int as claude_code,
         count(*) filter (where capacity->'signedIn' ? 'codex')::int as codex
       from runtime_hosts where workspace_id = $1 and owner_id is not null and removed_at is null)
     update machine_counts set (machines, claude_code, codex) = (counted.machines, counted.claude_code, counted.codex)
     from counted where machine_counts.workspace_id = $1
       and (machine_counts.machines, machine_counts.claude_code, machine_counts.codex)
         is distinct from (counted.machines, counted.claude_code, counted.codex)`,
    [workspaceId],
  )
}

export const expireRuntimeHostClaims = (tx: Transaction, workspaceId: string, now: number) =>
  onServer(
    tx,
    `update runtime_hosts set status = 'expired'
     where workspace_id = $1 and status = 'waiting' and claim_expires_at <= to_timestamp($2::double precision / 1000)`,
    [workspaceId, now],
  )

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
  waitingOnHost: `(host_id = $2 and state <> 'removed' or failure in ('no_host', 'no_capacity') and chat_id in (
    select chats.id from chats join runtime_hosts on runtime_hosts.workspace_id = chats.workspace_id
      and runtime_hosts.owner_id = chats.owner_user_id
    where chats.workspace_id = $1 and chats.local_session and runtime_hosts.id = $2)) for update`,
  idle: `(state = 'running' and last_active_at < to_timestamp($2::double precision / 1000)
    or (state = 'stopped' or state = 'failed' and host_id is not null)
      and last_active_at < to_timestamp($3::double precision / 1000)) for update skip locked`,
}

export const lockRuntimes = async (
  tx: Transaction,
  workspaceId: string,
  scope: keyof typeof runtimeLocks,
  ...keys: (string | number)[]
) => {
  if (scope === 'chat')
    await onServer(tx, 'select 1 from chats where workspace_id = $1 and id = $2 for update', [workspaceId, ...keys])
  const rows = await onServer<{ id: string }>(
    tx,
    `select id from runtimes where workspace_id = $1 and ${runtimeLocks[scope]}`,
    [workspaceId, ...keys],
  )
  return rows.map((row) => row.id)
}

export const lockRuntimeHostLoads = (tx: Transaction, workspaceId: string, chatId: string) =>
  onServer<{ hostId: string; online: boolean; cap: number; running: number }>(
    tx,
    `select id as "hostId", status = 'online' as online, coalesce((capacity->>'cap')::int, 0) as cap,
       (select count(*)::int from runtimes where runtimes.workspace_id = runtime_hosts.workspace_id
          and runtimes.host_id = runtime_hosts.id and runtimes.state in ('creating', 'starting', 'installing', 'running', 'stopping')
       ) as running
     from runtime_hosts where workspace_id = $1 and removed_at is null and owner_id is not distinct from
       (select case when local_session then owner_user_id end from chats where workspace_id = $1 and id = $2)
     for update`,
    [workspaceId, chatId],
  )

const serverOnlyRuntimeColumns = {
  llmTokenHash: 'llm_token_hash',
  agentConversation: 'agent_conversation_id',
  workspaceSnapshot: 'workspace_snapshot',
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
  firstOnServer<{
    promptId: string | null
    prompterId: string | null
    ownerId: string | null
    failure: string | null
    localSession: boolean
    sessionId: string | null
  }>(
    tx,
    `select agent_turn_message_id as "promptId", agent_turn_prompter_id as "prompterId", owner_user_id as "ownerId",
       agent_turn_failure as failure, local_session as "localSession",
       (select agent_conversation_id from runtimes
        where runtimes.workspace_id = chats.workspace_id and runtimes.chat_id = chats.id) as "sessionId"
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
      `select chat_id as "chatId" from runtimes where workspace_id = $1 and host_id = $2 and llm_token_hash = $3
         and exists(select 1 from workspaces where workspaces.workspace_id = $1 and workspaces.deleted_at is null)`,
      [workspaceId, hostId, hash],
    )
  )?.chatId

const answeringReply = (prompt: string) =>
  `select 1 from messages reply where reply.workspace_id = ${prompt}.workspace_id and reply.reply_to_id = ${prompt}.id
     and not (reply.kind = 'notice' and reply.body = any($3::text[]))`

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
         and prompt.seq > coalesce((select answered.seq from messages answered
           where answered.workspace_id = $1 and answered.chat_id = $2 and answered.kind = 'member'
             and answered.reply_to_id is null and exists (${answeringReply('answered')})
           order by answered.seq desc limit 1), 0)
         and not exists (${answeringReply('prompt')})
       order by prompt.seq`,
      [workspaceId, chatId, waitingNoticeBodies],
    )
  ).map((prompt) => prompt.id)

export const activeAgentTurns = (tx: Transaction, workspaceId: string) =>
  onServer<{ chatId: string; promptId: string; lastEventAt: number }>(
    tx,
    `select id as "chatId", agent_turn_message_id as "promptId",
       (select extract(epoch from created_at) * 1000 from events
        where events.workspace_id = chats.workspace_id and events.chat_id = chats.id order by seq desc limit 1)::float8
         as "lastEventAt"
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

export const isSessionStartPending = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    await onServer(
      tx,
      `select 1 from jobs where workspace_id = $1 and type = 'agent.start-session' and payload->>'chatId' = $2
       and state in ('queued', 'running') limit 1`,
      [workspaceId, chatId],
    )
  ).length > 0

export const lastAgentEvent = (tx: Transaction, workspaceId: string, chatId: string) =>
  firstOnServer<{
    id: string
    seq: number | null
    timestamp: string
    replyToId: string | null
    sessionUpdate: string | null
  }>(
    tx,
    `select id, (payload->'event'->>'seq')::int as seq, payload->'event'->>'timestamp' as timestamp,
       payload->>'replyToId' as "replyToId", payload->'event'->'update'->>'sessionUpdate' as "sessionUpdate" from events
     where workspace_id = $1 and chat_id = $2 and type = 'agent.event' order by events.seq desc limit 1`,
    [workspaceId, chatId],
  )

export const lastSessionId = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    await firstOnServer<{ sessionId: string | null }>(
      tx,
      `select payload->'event'->'update'->>'sessionId' as "sessionId" from events
       where workspace_id = $1 and chat_id = $2 and type = 'agent.event'
       and payload->'event'->'update'->>'sessionUpdate' = 'session_started' and payload->'delegation' is null
       order by seq desc limit 1`,
      [workspaceId, chatId],
    )
  )?.sessionId ?? undefined

export const chatEventsOf = async (tx: Transaction, workspaceId: string, chatId: string) =>
  (
    await onServer<{
      workspaceId: string
      chatId: string
      id: string
      seq: number
      type: string
      actor: string | null
      payload: unknown
      createdAtMilliseconds: string
    }>(
      tx,
      `select workspace_id as "workspaceId", chat_id as "chatId", id, seq, type, actor, payload,
         extract(epoch from created_at) * 1000 as "createdAtMilliseconds"
       from events where workspace_id = $1 and chat_id = $2 order by seq`,
      [workspaceId, chatId],
    )
  ).map(({ createdAtMilliseconds, ...event }) => ({ ...event, createdAt: new Date(Number(createdAtMilliseconds)) }))

export const openTaskStepsOf = <Step>(tx: Transaction, workspaceId: string, promptId: string) =>
  onServer<{ id: string; step: Step }>(
    tx,
    `select id, step from messages where workspace_id = $1 and reply_to_id = $2 and step->>'type' = 'tool'
       and step->>'name' = 'Task' and step->'result' = 'null'::jsonb order by seq`,
    [workspaceId, promptId],
  )

export const lastAdapterModelsOf = (tx: Transaction, workspaceId: string, chatId: string) =>
  firstOnServer<{
    isThisChat: boolean
    currentModelId: string | null
    availableModels: { model_id: string; name: string }[]
    currentEffort: string | null
    availableEfforts: { id: string; name: string }[] | null
  }>(
    tx,
    `select events.chat_id = $2 as "isThisChat",
       coalesce(payload->'event'->'value'->>'acp_current_model_id', found.option->>'currentValue') as "currentModelId",
       coalesce(payload->'event'->'value'->'acp_available_models',
         (select jsonb_agg(jsonb_build_object('model_id', choice->>'value', 'name', choice->>'name'))
          from jsonb_array_elements(found.option->'options') choice)) as "availableModels",
       effort.option->>'currentValue' as "currentEffort",
       (select jsonb_agg(jsonb_build_object('id', choice->>'value', 'name', choice->>'name'))
        from jsonb_array_elements(effort.option->'options') choice) as "availableEfforts"
     from chats this join chats seen on seen.workspace_id = this.workspace_id and seen.owner_user_id = this.owner_user_id
       and seen.harness = this.harness and seen.local_session
     join events on events.workspace_id = seen.workspace_id and events.chat_id = seen.id
     cross join lateral (select jsonb_path_query_first(payload->'event',
       '$.update.configOptions[*] ? (@.category == "model")') as option) found
     cross join lateral (select jsonb_path_query_first(payload->'event',
       '$.update.configOptions[*] ? (@.category == "thought_level")') as option) effort
     where this.workspace_id = $1 and this.id = $2 and this.local_session and events.type = 'agent.event'
       and ((payload->'event'->>'key' = 'agent_state'
           and jsonb_typeof(payload->'event'->'value'->'acp_available_models') = 'array')
         or (payload->'event'->'update'->>'sessionUpdate' in ('session_started', 'config_option_update')
           and jsonb_typeof(found.option->'options') = 'array'))
     order by events.chat_id = $2 desc, events.created_at desc, events.seq desc limit 1`,
    [workspaceId, chatId],
  )

export const isWorkspaceHostOnline = async (tx: Transaction, workspaceId: string) =>
  (
    await firstOnServer<{ online: boolean }>(
      tx,
      `select exists (select from runtime_hosts where workspace_id = $1 and owner_id is null and removed_at is null
         and status = 'online') as online`,
      [workspaceId],
    )
  )?.online ?? false

export const finishedToolCallEventOf = async (tx: Transaction, workspaceId: string, chatId: string, stepId: string) =>
  (
    await firstOnServer<{ event: Record<string, unknown> }>(
      tx,
      `select payload->'event' as event from events
       where workspace_id = $1 and chat_id = $2 and type = 'agent.event'
       and split_part(payload->'event'->>'id', ':', 1) = split_part($3, ':', 1)
       and payload->'event'->'update'->>'toolCallId' = substr($3, strpos($3, ':') + 1)
       and payload->'event'->'update'->>'status' in ('completed', 'failed')
       order by seq desc limit 1`,
      [workspaceId, chatId, stepId],
    )
  )?.event

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
    agentModel: string | null
    agentReasoningEffort: string | null
    subagentPolicy: string
    harness: HarnessId | null
  }>(
    tx,
    `select mode, owner_user_id as "ownerId", model, reasoning_effort as "reasoningEffort",
       agent_model as "agentModel", agent_reasoning_effort as "agentReasoningEffort", subagent_policy as "subagentPolicy", harness
     from chats where workspace_id = $1 and id = $2`,
    [workspaceId, chatId],
  )

export const setChatAgentModel = (
  tx: Transaction,
  workspaceId: string,
  chatId: string,
  model: string | null,
  reasoningEffort: string | null,
) =>
  onServer(tx, 'update chats set agent_model = $3, agent_reasoning_effort = $4 where workspace_id = $1 and id = $2', [
    workspaceId,
    chatId,
    model,
    reasoningEffort,
  ])

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

export const insertToolCall = (tx: Transaction, call: Record<string, unknown>) =>
  insertServerOnlyRow(tx, 'tool_calls', call)

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

export const stopRunningDelegations = async (tx: Transaction, workspaceId: string, chatId: string, promptId: string) =>
  (
    await onServer<{ conversationId: string | null }>(
      tx,
      `update delegations set status = 'stopped', finished_at = now()
       where workspace_id = $1 and chat_id = $2 and prompt_id = $3 and status = 'running'
       returning conversation_id as "conversationId"`,
      [workspaceId, chatId, promptId],
    )
  ).flatMap((row) => row.conversationId ?? [])

export const runningDelegationOfTokenHash = (tx: Transaction, workspaceId: string, hostId: string, hash: string) =>
  firstOnServer<{ chatId: string; id: string; promptId: string }>(
    tx,
    `select delegations.chat_id as "chatId", delegations.id, delegations.prompt_id as "promptId" from delegations join runtimes
       on runtimes.workspace_id = delegations.workspace_id and runtimes.chat_id = delegations.chat_id
     where delegations.workspace_id = $1 and runtimes.host_id = $2 and delegations.token_hash = $3
       and delegations.status = 'running'
       and exists(select 1 from workspaces where workspaces.workspace_id = $1 and workspaces.deleted_at is null)`,
    [workspaceId, hostId, hash],
  )

type StoredAttachment = { id: string; name: string; mediaType: string; size: number }
const attachmentColumns = 'id, name, media_type as "mediaType", size'

export const insertAttachment = (
  tx: Transaction,
  attachment: StoredAttachment & { workspaceId: string; chatId: string; uploaderId: string; content: Uint8Array },
) =>
  onServer(
    tx,
    `insert into message_attachments (workspace_id, chat_id, id, uploader_id, name, media_type, size, content, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::bytea, now())`,
    [
      attachment.workspaceId,
      attachment.chatId,
      attachment.id,
      attachment.uploaderId,
      attachment.name,
      attachment.mediaType,
      attachment.size,
      attachment.content,
    ],
  )

const pendingAttachmentLifetime = "interval '1 day'"

export const storedAttachmentBytesOf = async (tx: Transaction, workspaceId: string, uploaderId: string) => {
  await onServer(tx, `select pg_advisory_xact_lock(hashtextextended('message_attachments:' || $1, 0))`, [workspaceId])
  const [stored] = await onServer<{ pendingOfMember: number; inWorkspace: number }>(
    tx,
    `select
       coalesce(sum(size) filter (where uploader_id = $2 and message_id is null
         and created_at > now() - ${pendingAttachmentLifetime}), 0)::bigint::float8 as "pendingOfMember",
       coalesce(sum(size), 0)::bigint::float8 as "inWorkspace"
     from message_attachments where workspace_id = $1`,
    [workspaceId, uploaderId],
  )
  return stored ?? { pendingOfMember: 0, inWorkspace: 0 }
}

export const deleteAbandonedAttachments = (tx: Transaction, workspaceId: string) =>
  onServer(
    tx,
    `delete from message_attachments where workspace_id = $1 and message_id is null
       and created_at < now() - ${pendingAttachmentLifetime}`,
    [workspaceId],
  )

export const lockPendingAttachments = (
  tx: Transaction,
  { workspaceId, chatId, uploaderId, ids }: { workspaceId: string; chatId: string; uploaderId: string; ids: string[] },
) =>
  onServer<StoredAttachment>(
    tx,
    `select ${attachmentColumns} from message_attachments
     where workspace_id = $1 and chat_id = $2 and uploader_id = $3 and message_id is null and id = any($4::text[])
     order by array_position($4::text[], id) for update`,
    [workspaceId, chatId, uploaderId, ids],
  )

export const linkAttachments = (tx: Transaction, workspaceId: string, messageId: string, ids: string[]) =>
  onServer(
    tx,
    'update message_attachments set message_id = $2 where workspace_id = $1 and id = any($3::text[]) and message_id is null',
    [workspaceId, messageId, ids],
  )

export const keepDeletedMessageText = (
  tx: Transaction,
  deleted: { workspaceId: string; chatId: string; messageId: string; body: string; deletedBy: string; deletedAt: Date },
) =>
  onServer(
    tx,
    `insert into deleted_message_texts (workspace_id, chat_id, message_id, body, deleted_by, deleted_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [
      deleted.workspaceId,
      deleted.chatId,
      deleted.messageId,
      deleted.body,
      deleted.deletedBy,
      deleted.deletedAt.toISOString(),
    ],
  )

export const redactDeletedMessageEvents = async (
  tx: Transaction,
  deleted: { workspaceId: string; chatId: string; messageId: string },
) => {
  await onServer(tx, `select set_config('spyria.redacting_message', $1, true)`, [
    `${deleted.workspaceId}/${deleted.messageId}`,
  ])
  await onServer(
    tx,
    `update events set payload = (payload - 'attachments') || '{"body": "", "redacted": true}'::jsonb
     where workspace_id = $1 and chat_id = $2
       and ((type in ('message.posted', 'message.replied') and id = $3)
         or (type = 'message.edited' and payload->>'messageId' = $3))`,
    [deleted.workspaceId, deleted.chatId, deleted.messageId],
  )
  await onServer(tx, `select set_config('spyria.redacting_message', '', true)`, [])
}

export const deleteMessageAttachments = (tx: Transaction, workspaceId: string, messageId: string) =>
  onServer(tx, 'delete from message_attachments where workspace_id = $1 and message_id = $2', [workspaceId, messageId])

export const sentAttachmentOf = (tx: Transaction, workspaceId: string, chatId: string, id: string) =>
  firstOnServer<StoredAttachment & { content: Uint8Array<ArrayBuffer> }>(
    tx,
    `select ${attachmentColumns}, content from message_attachments
     where workspace_id = $1 and chat_id = $2 and id = $3 and message_id is not null`,
    [workspaceId, chatId, id],
  )

export const workspaceTablesInPurgeOrder = [
  'thread_read_markers',
  'read_markers',
  'runtime_origins',
  'browser_pages',
  'sources',
  'routing_decisions',
  'delegations',
  'tool_calls',
  'usage_entries',
  'events',
  'message_attachments',
  'deleted_message_texts',
  'messages',
  'runtimes',
  'runtime_hosts',
  'machine_counts',
  'chat_participants',
  'chats',
  'chat_roles',
  'projects',
  'service_identities',
  'budget_alerts',
  'budgets',
  'connection_restrictions',
  'workspace_connections',
  'github_connections',
  'identities',
  'invitations',
  'llm_credentials',
  'member_gateway_keys',
  'member_onboarding',
  'sessions',
  'tool_connections',
  'memberships',
  'workspace_role_permissions',
  'workspace_roles',
  'audit_settings',
  'github_webhook_deliveries',
  'github_apps',
  'jobs',
  'model_calls',
  'sso_domains',
  'workspace_sso',
  'usage_sync_marks',
  'workspace_events',
  'workspace_onboarding',
  'workspaces',
] as const

export const workspacePurgeJobType = 'workspace.purge'
export const workspaceHaltJobType = 'workspace.halt'
export const workspaceCleanupJobTypes = [
  workspaceHaltJobType,
  'runtime.stop',
  'runtime.remove',
  'runtime.discard',
  'profile.gateway-sync',
  'profile.tool-server-removal',
] as const
export const jobTypesOfDeletedWorkspaces = [workspacePurgeJobType, ...workspaceCleanupJobTypes]

const chunkedTablesInPurgeOrder = [
  'thread_read_markers',
  'read_markers',
  'runtime_origins',
  'message_attachments',
  'deleted_message_texts',
  'tool_calls',
  'usage_entries',
  'model_calls',
  'events',
  'workspace_events',
  'sources',
  'browser_pages',
  'routing_decisions',
  'delegations',
] as const
const unreferencedMessages = `
  select message.ctid from messages message where message.workspace_id = $1
    and not exists(select 1 from messages other where other.workspace_id = message.workspace_id
      and other.id <> message.id and message.id in (other.reply_to_id, other.thread_root_id, other.quoted_message_id))
  limit $2`

export const scheduleWorkspaceDeletion = (tx: Transaction, workspaceId: string, purgeAt: number) =>
  onServer(
    tx,
    `with deleted as (
       update workspaces set deleted_at = now(), purge_at = to_timestamp($2::double precision / 1000)
       where workspace_id = $1 and deleted_at is null returning workspace_id),
     ended_sessions as (delete from sessions where workspace_id in (select workspace_id from deleted)),
     cancelled_jobs as (
       delete from jobs where workspace_id in (select workspace_id from deleted) and state = 'queued')
     select workspace_id from deleted`,
    [workspaceId, purgeAt],
  )

export const lockDuePurge = async (tx: Transaction, workspaceId: string) =>
  (
    await firstOnServer<{ isDue: boolean }>(
      tx,
      `select purge_at <= now() as "isDue" from workspaces where workspace_id = $1 and deleted_at is not null
       for update`,
      [workspaceId],
    )
  )?.isDue ?? false

export const isWorkspaceDeleted = async (tx: Transaction, workspaceId: string) =>
  (
    await firstOnServer<{ isDeleted: boolean }>(
      tx,
      'select deleted_at is not null as "isDeleted" from workspaces where workspace_id = $1',
      [workspaceId],
    )
  )?.isDeleted ?? false

export const workspacePurgeTargetsOf = async (tx: Transaction, workspaceId: string) => ({
  memberIds: (
    await onServer<{ id: string }>(tx, 'select user_id as id from memberships where workspace_id = $1', [workspaceId])
  ).map(({ id }) => id),
  runtimeChatIds: (
    await onServer<{ id: string }>(tx, `select id from chats where workspace_id = $1 and type = 'runtime'`, [
      workspaceId,
    ])
  ).map(({ id }) => id),
})

export const workspaceCleanupOf = async (tx: Transaction, workspaceId: string) => {
  const jobs = await onServer<{ type: string; state: string; count: number }>(
    tx,
    `select type, state, count(*)::int as count from jobs
     where workspace_id = $1 and type = any($2::text[]) and state in ('queued', 'running', 'failed')
     group by type, state order by type, state`,
    [workspaceId, workspaceCleanupJobTypes],
  )
  return {
    isPending: jobs.some(({ state }) => state !== 'failed'),
    failed: jobs.filter(({ state }) => state === 'failed').map(({ type, count }) => ({ type, count })),
  }
}

const purgingWorkspace = (tx: Transaction, workspaceId: string) =>
  onServer(tx, `select set_config('spyria.purging_workspace', $1, true)`, [workspaceId])

export const purgeWorkspaceChunk = async (tx: Transaction, workspaceId: string, chunkSize: number) => {
  await purgingWorkspace(tx, workspaceId)
  for (const table of chunkedTablesInPurgeOrder) {
    const deleted = await onServer(
      tx,
      `delete from ${table} where ctid in (select ctid from ${table} where workspace_id = $1 limit $2) returning 1`,
      [workspaceId, chunkSize],
    )
    if (deleted.length > 0) return deleted.length
  }
  return (
    await onServer(tx, `delete from messages where ctid in (${unreferencedMessages}) returning 1`, [
      workspaceId,
      chunkSize,
    ])
  ).length
}

export const purgeWorkspaceRows = async (tx: Transaction, workspaceId: string) => {
  const userIds = (
    await onServer<{ id: string }>(
      tx,
      `select user_id as id from memberships where workspace_id = $1
       union select created_by from workspaces where workspace_id = $1`,
      [workspaceId],
    )
  ).map(({ id }) => id)
  await purgingWorkspace(tx, workspaceId)
  for (const table of workspaceTablesInPurgeOrder)
    await onServer(tx, `delete from ${table} where workspace_id = $1`, [workspaceId])
  await onServer(
    tx,
    `delete from users where id = any($1::text[])
       and not exists(select 1 from memberships where memberships.user_id = users.id)
       and not exists(select 1 from workspaces where workspaces.created_by = users.id)`,
    [userIds],
  )
}

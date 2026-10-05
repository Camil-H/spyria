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

export const lockMembership = (tx: Transaction, workspaceId: string, userId: string) =>
  onServer(tx, 'select 1 from memberships where workspace_id = $1 and user_id = $2 for update', [workspaceId, userId])

export const enqueueJob = (
  tx: Transaction,
  job: { workspaceId: string; type: string; payload: object; delayMilliseconds: number },
) =>
  onServer(
    tx,
    `insert into jobs (workspace_id, id, type, payload, run_at, attempts, state) values ($1, $2, $3, $4::jsonb, now() + make_interval(secs => $5::double precision / 1000), 0, 'queued')`,
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

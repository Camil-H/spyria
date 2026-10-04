import type { Transaction } from '@rocicorp/zero'

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

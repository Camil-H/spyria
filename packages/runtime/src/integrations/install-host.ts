import { hashSecret, installHostClaimLifetimeMilliseconds } from '../domain/claim.ts'

type Sql = (template: TemplateStringsArray, ...values: (string | number)[]) => PromiseLike<unknown>

export const addInstallHost = async (
  sql: Sql,
  { workspaceId, createdBy, installHostToken }: { workspaceId: string; createdBy: string; installHostToken: string },
) => {
  const claimCodeHash = await hashSecret(installHostToken)
  await sql`
    insert into runtime_hosts (workspace_id, id, name, claim_code_hash, claim_expires_at, status, running_runtimes,
      created_by, created_at)
    values (${workspaceId}, ${crypto.randomUUID()}, 'This machine', ${claimCodeHash},
      now() + ${`${installHostClaimLifetimeMilliseconds} milliseconds`}::interval, 'waiting', 0, ${createdBy}, now())`
}

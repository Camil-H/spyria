import type { ZeroContext } from '@hq/db/zero-queries'
import { type MemberId, memberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import type { LlmGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { Secret } from '../domain/secret.ts'
import { createZeroTransactor, profileJobTypes } from '../integrations/zero-transactor.ts'
import { addLlmCredential } from '../operations/add-llm-credential.ts'
import { runGatewaySync, virtualKeyValueOf } from '../operations/sync-member-gateway-key.ts'

type Transact = <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>
type Job = { workspaceId: string; payload: unknown; transact: Transact }

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')
const id = z.string().check(z.minLength(1))
const gatewaySyncPayload = z.object({
  memberId: z.pipe(id, z.transform(memberId)),
  key: z.object({ provider: id, id }),
})

const transactorAs = (transact: Transact, context: ZeroContext): ProfileTransactor => ({
  run: (work) => transact((tx) => createZeroTransactor(tx, context).run(work)),
})
const memberContext = (workspace: WorkspaceId, member: MemberId): ZeroContext => ({
  workspaceId: workspace,
  userId: member,
  role: 'member',
})

export const addLlmCredentialFromRequest = (
  transact: Transact,
  context: ZeroContext,
  body: unknown,
  gateway: LlmGateway,
) => {
  const { provider, secret } = (body ?? {}) as Record<string, unknown>
  return addLlmCredential(
    { transactor: transactorAs(transact, context), gateway },
    {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      memberId: context.userId,
      provider: textOf(provider),
      secret: new Secret(textOf(secret)),
    },
  )
}

export const createProfileJobs = (gateway: LlmGateway) => ({
  [profileJobTypes.gatewaySync]: ({ workspaceId: workspace, payload, transact }: Job) => {
    const job = gatewaySyncPayload.parse(payload)
    const transactor = transactorAs(transact, memberContext(workspaceId(workspace), job.memberId))
    return runGatewaySync({ transactor, gateway }, { ...job, workspaceId: workspaceId(workspace) })
  },
})

export const createMemberKeyReader =
  (transact: Transact, gateway: LlmGateway) => (workspace: WorkspaceId, member: MemberId) =>
    virtualKeyValueOf(
      { transactor: transactorAs(transact, memberContext(workspace, member)), gateway },
      { workspaceId: workspace, memberId: member },
    )

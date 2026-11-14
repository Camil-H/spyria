import { type GatewayKey, MemberNotFound } from '@spyria/kernel'
import type { GatewaySyncJob, LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { LlmCredential } from '../domain/llm-credential.ts'
import { grantMemberTools, grantMemberToolsOrRetryLater, inMemberOrderOf, releaseLostSignIns } from './grant-tools.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway }

const inMemberOrder = inMemberOrderOf()

export const syncMemberGatewayKey = (
  { transactor, gateway }: Dependencies,
  { added, isLeaving = false }: { added?: { credential: LlmCredential; key: GatewayKey }; isLeaving?: boolean } = {},
) =>
  inMemberOrder(transactor.member, async () => {
    const { member } = transactor
    const { keys, virtualKeyId, virtualKeyName, isActive } = await transactor.run(
      async ({ llmCredentials, memberGatewayKeys, members }) => ({
        keys: await llmCredentials.gatewayKeys(),
        virtualKeyId: await memberGatewayKeys.virtualKey(),
        virtualKeyName: await memberGatewayKeys.virtualKeyName(),
        isActive: await members.isActive(member.workspaceId, member.memberId),
      }),
    )
    if (isLeaving || !isActive) {
      const leftKeyId = virtualKeyId ?? (virtualKeyName && (await gateway.virtualKeyNamed(virtualKeyName)))
      if (leftKeyId) await gateway.removeVirtualKey(leftKeyId)
      await transactor.run(async ({ memberGatewayKeys, toolConnections }) => {
        await memberGatewayKeys.setVirtualKey(null)
        await toolConnections.removeAll()
      })
      if (added) throw new MemberNotFound(member.memberId)
      return undefined
    }
    const syncedKeys = added ? [...keys, added.key] : keys
    const name =
      virtualKeyName ?? (await transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.reserveVirtualKeyName()))
    const savedId = await gateway.saveVirtualKey({ id: virtualKeyId, name, keys: syncedKeys })
    if (savedId === virtualKeyId && !added) return savedId
    try {
      await transactor.run(async ({ llmCredentials, memberGatewayKeys, members }) => {
        if (added) {
          await members.lockActive()
          await llmCredentials.add(added.credential, added.key)
        }
        if (savedId !== virtualKeyId) await memberGatewayKeys.setVirtualKey(savedId)
      })
    } catch (error) {
      if (savedId !== virtualKeyId || error instanceof MemberNotFound) await gateway.removeVirtualKey(savedId)
      else await gateway.saveVirtualKey({ id: virtualKeyId, name, keys })
      if (virtualKeyId === undefined)
        await transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.setVirtualKey(null))
      throw error
    }
    return savedId
  })

export const ensureMemberGatewayKey = async (dependencies: Dependencies) => {
  const virtualKeyId = await dependencies.transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKey())
  if (virtualKeyId) return virtualKeyId
  const createdId = await syncMemberGatewayKey(dependencies)
  if (createdId) await grantMemberToolsOrRetryLater(dependencies, dependencies.transactor.member)
  return createdId
}

export const toolKeyValueOf = async (dependencies: Dependencies) => {
  const virtualKeyId = await ensureMemberGatewayKey(dependencies)
  return virtualKeyId && dependencies.gateway.virtualKeyValue(virtualKeyId)
}

export const runGatewaySync = async (
  dependencies: Dependencies,
  { key, isLeaving }: Pick<GatewaySyncJob, 'key' | 'isLeaving'>,
) => {
  const syncedId = await syncMemberGatewayKey(dependencies, { isLeaving })
  const { workspaceId, memberId } = dependencies.transactor.member
  if (syncedId) await grantMemberTools(dependencies, { workspaceId, memberId })
  if (!isLeaving) await releaseLostSignIns(dependencies, workspaceId, { memberIds: [memberId] })
  if (key) await dependencies.gateway.removeProviderKey(key)
}

export const virtualKeyValueOf = async ({
  transactor,
  gateway,
}: {
  transactor: ProfileTransactor
  gateway: LlmGateway
}) => {
  const { virtualKeyId, hasProviderKey } = await transactor.run(async ({ memberGatewayKeys, llmCredentials }) => ({
    virtualKeyId: await memberGatewayKeys.virtualKey(),
    hasProviderKey: (await llmCredentials.gatewayKeys()).length > 0,
  }))
  return hasProviderKey && virtualKeyId ? gateway.virtualKeyValue(virtualKeyId) : undefined
}

export const syncMemberGatewayKeyLater = ({ transactor }: Pick<Dependencies, 'transactor'>) =>
  transactor.run(({ gatewayJobs }) => gatewayJobs.syncLater({}))

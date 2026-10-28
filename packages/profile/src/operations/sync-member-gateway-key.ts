import { type GatewayKey, log } from '@spyria/kernel'
import type { GatewaySyncJob, LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ActingMember, ProfileTransactor } from '../contracts/transactor.ts'
import type { LlmCredential } from '../domain/llm-credential.ts'
import { grantMemberTools } from './grant-tools.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway }

const syncsByMember = new Map<string, Promise<unknown>>()

const inMemberOrder = <Result>({ workspaceId, memberId }: ActingMember, work: () => Promise<Result>) => {
  const memberKey = `${workspaceId}/${memberId}`
  const result = (syncsByMember.get(memberKey) ?? Promise.resolve()).then(work, work)
  const settled = result.catch(() => {})
  syncsByMember.set(memberKey, settled)
  settled.then(() => syncsByMember.get(memberKey) === settled && syncsByMember.delete(memberKey))
  return result
}

export const syncMemberGatewayKey = (
  { transactor, gateway }: Dependencies,
  { added, isLeaving = false }: { added?: { credential: LlmCredential; key: GatewayKey }; isLeaving?: boolean } = {},
) =>
  inMemberOrder(transactor.member, async () => {
    const { member } = transactor
    const grantTools = () =>
      grantMemberTools({ transactor, gateway }, member).catch((error) =>
        log.error({
          event: 'member_tools.grant_failed',
          body: 'Granting the workspace tools of a member failed',
          attributes: { 'workspace.id': member.workspaceId, 'member.id': member.memberId },
          error,
        }),
      )
    const { keys, virtualKeyId, isActive } = await transactor.run(
      async ({ llmCredentials, memberGatewayKeys, members }) => ({
        keys: await llmCredentials.gatewayKeys(),
        virtualKeyId: await memberGatewayKeys.virtualKey(),
        isActive: await members.isActive(member.workspaceId, member.memberId),
      }),
    )
    if (isLeaving || !isActive) {
      if (virtualKeyId) await gateway.removeVirtualKey(virtualKeyId)
      await transactor.run(async ({ memberGatewayKeys, personalConnections }) => {
        await memberGatewayKeys.setVirtualKey(null)
        await personalConnections.removeAll()
      })
      return undefined
    }
    const syncedKeys = added ? [...keys, added.key] : keys
    const savedId = await gateway.saveVirtualKey({ id: virtualKeyId, keys: syncedKeys })
    if (savedId === virtualKeyId && !added) {
      await grantTools()
      return savedId
    }
    try {
      await transactor.run(async ({ llmCredentials, memberGatewayKeys }) => {
        if (added) await llmCredentials.add(added.credential, added.key)
        if (savedId !== virtualKeyId) await memberGatewayKeys.setVirtualKey(savedId)
      })
    } catch (error) {
      if (savedId !== virtualKeyId) await gateway.removeVirtualKey(savedId)
      else await gateway.saveVirtualKey({ id: virtualKeyId, keys })
      throw error
    }
    await grantTools()
    return savedId
  })

export const ensureMemberGatewayKey = async (dependencies: Dependencies) =>
  (await dependencies.transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKey())) ??
  syncMemberGatewayKey(dependencies)

export const toolKeyValueOf = async (dependencies: Dependencies) => {
  const virtualKeyId = await ensureMemberGatewayKey(dependencies)
  return virtualKeyId && dependencies.gateway.virtualKeyValue(virtualKeyId)
}

export const runGatewaySync = async (
  dependencies: Dependencies,
  { key, isLeaving }: Pick<GatewaySyncJob, 'key' | 'isLeaving'>,
) => {
  await syncMemberGatewayKey(dependencies, { isLeaving })
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

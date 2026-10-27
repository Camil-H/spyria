import { log, type MemberId, type WorkspaceId } from '@spyria/kernel'
import type { GatewaySyncJob, LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { GatewayKey, LlmCredential } from '../domain/llm-credential.ts'
import { grantMemberTools } from './grant-tools.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway }
type Member = { workspaceId: WorkspaceId; memberId: MemberId }

const syncsByMember = new Map<string, Promise<unknown>>()

const inMemberOrder = <Result>({ workspaceId, memberId }: Member, work: () => Promise<Result>) => {
  const memberKey = `${workspaceId}/${memberId}`
  const result = (syncsByMember.get(memberKey) ?? Promise.resolve()).then(work, work)
  const settled = result.catch(() => {})
  syncsByMember.set(memberKey, settled)
  settled.then(() => syncsByMember.get(memberKey) === settled && syncsByMember.delete(memberKey))
  return result
}

export const syncMemberGatewayKey = (
  { transactor, gateway }: Dependencies,
  member: Member,
  { added, isLeaving = false }: { added?: { credential: LlmCredential; key: GatewayKey }; isLeaving?: boolean } = {},
) =>
  inMemberOrder(member, async () => {
    const { workspaceId, memberId } = member
    const grantTools = () =>
      grantMemberTools({ transactor, gateway }, member).catch((error) =>
        log.error({
          event: 'member_tools.grant_failed',
          body: 'Granting the workspace tools of a member failed',
          attributes: { 'workspace.id': workspaceId, 'member.id': memberId },
          error,
        }),
      )
    const { keys, virtualKeyId, isActive } = await transactor.run(
      async ({ llmCredentials, memberGatewayKeys, members }) => ({
        keys: await llmCredentials.gatewayKeysOf(workspaceId, memberId),
        virtualKeyId: await memberGatewayKeys.virtualKeyOf(workspaceId, memberId),
        isActive: await members.isActive(workspaceId, memberId),
      }),
    )
    if (isLeaving || !isActive) {
      if (virtualKeyId) await gateway.removeVirtualKey(virtualKeyId)
      await transactor.run(async ({ memberGatewayKeys, personalConnections }) => {
        await memberGatewayKeys.setVirtualKey(workspaceId, memberId, null)
        await personalConnections.removeAll(workspaceId, memberId)
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
        if (savedId !== virtualKeyId) await memberGatewayKeys.setVirtualKey(workspaceId, memberId, savedId)
      })
    } catch (error) {
      if (savedId !== virtualKeyId) await gateway.removeVirtualKey(savedId)
      else await gateway.saveVirtualKey({ id: virtualKeyId, keys })
      throw error
    }
    await grantTools()
    return savedId
  })

export const ensureMemberGatewayKey = async (dependencies: Dependencies, member: Member) =>
  (await dependencies.transactor.run(({ memberGatewayKeys }) =>
    memberGatewayKeys.virtualKeyOf(member.workspaceId, member.memberId),
  )) ?? syncMemberGatewayKey(dependencies, member)

export const toolKeyValueOf = async (dependencies: Dependencies, member: Member) => {
  const virtualKeyId = await ensureMemberGatewayKey(dependencies, member)
  return virtualKeyId && dependencies.gateway.virtualKeyValue(virtualKeyId)
}

export const runGatewaySync = async (dependencies: Dependencies, { key, isLeaving, ...member }: GatewaySyncJob) => {
  await syncMemberGatewayKey(dependencies, member, { isLeaving })
  if (key) await dependencies.gateway.removeProviderKey(key)
}

export const virtualKeyValueOf = async (
  { transactor, gateway }: { transactor: ProfileTransactor; gateway: LlmGateway },
  { workspaceId, memberId }: Member,
) => {
  const { virtualKeyId, hasProviderKey } = await transactor.run(async ({ memberGatewayKeys, llmCredentials }) => ({
    virtualKeyId: await memberGatewayKeys.virtualKeyOf(workspaceId, memberId),
    hasProviderKey: (await llmCredentials.gatewayKeysOf(workspaceId, memberId)).length > 0,
  }))
  return hasProviderKey && virtualKeyId ? gateway.virtualKeyValue(virtualKeyId) : undefined
}

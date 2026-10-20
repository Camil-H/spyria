import { log, type MemberId, type WorkspaceId } from '@spyria/kernel'
import type { GatewaySyncJob, LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { GatewayKey, LlmCredential } from '../domain/llm-credential.ts'
import { grantMemberTools } from './tool-connections.ts'

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
  added?: { credential: LlmCredential; key: GatewayKey },
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
    const { keys, virtualKeyId } = await transactor.run(async ({ llmCredentials, memberGatewayKeys }) => ({
      keys: await llmCredentials.gatewayKeysOf(workspaceId, memberId),
      virtualKeyId: await memberGatewayKeys.virtualKeyOf(workspaceId, memberId),
    }))
    const syncedKeys = added ? [...keys, added.key] : keys
    if (syncedKeys.length === 0) {
      if (virtualKeyId) await gateway.removeVirtualKey(virtualKeyId)
      await transactor.run(async ({ memberGatewayKeys, personalConnections }) => {
        await memberGatewayKeys.setVirtualKey(workspaceId, memberId, null)
        await personalConnections.removeAll(workspaceId, memberId)
      })
      return
    }
    const savedId = await gateway.saveVirtualKey({ id: virtualKeyId, keys: syncedKeys })
    if (savedId === virtualKeyId && !added) return grantTools()
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
  })

export const runGatewaySync = async (dependencies: Dependencies, { key, ...member }: GatewaySyncJob) => {
  await syncMemberGatewayKey(dependencies, member)
  await dependencies.gateway.removeProviderKey(key)
}

export const virtualKeyValueOf = async (
  { transactor, gateway }: { transactor: ProfileTransactor; gateway: LlmGateway },
  { workspaceId, memberId }: Member,
) => {
  const virtualKeyId = await transactor.run(({ memberGatewayKeys }) =>
    memberGatewayKeys.virtualKeyOf(workspaceId, memberId),
  )
  return virtualKeyId && gateway.virtualKeyValue(virtualKeyId)
}

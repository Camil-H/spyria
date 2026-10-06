import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { GatewaySyncJob, LlmGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: LlmGateway }
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

export const syncMemberGatewayKey = ({ transactor, gateway }: Dependencies, member: Member) =>
  inMemberOrder(member, async () => {
    const { workspaceId, memberId } = member
    const { keys, virtualKeyId } = await transactor.run(async ({ llmCredentials, memberGatewayKeys }) => ({
      keys: await llmCredentials.gatewayKeysOf(workspaceId, memberId),
      virtualKeyId: await memberGatewayKeys.virtualKeyOf(workspaceId, memberId),
    }))
    if (keys.length === 0) {
      if (virtualKeyId) await gateway.removeVirtualKey(virtualKeyId)
      await transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.setVirtualKey(workspaceId, memberId, null))
      return
    }
    const savedId = await gateway.saveVirtualKey({ id: virtualKeyId, keys })
    if (savedId === virtualKeyId) return
    try {
      await transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.setVirtualKey(workspaceId, memberId, savedId))
    } catch (error) {
      await gateway.removeVirtualKey(savedId)
      throw error
    }
  })

export const runGatewaySync = async (dependencies: Dependencies, { key, ...member }: GatewaySyncJob) => {
  await syncMemberGatewayKey(dependencies, member)
  await dependencies.gateway.removeProviderKey(key)
}

export const virtualKeyValueOf = async ({ transactor, gateway }: Dependencies, { workspaceId, memberId }: Member) => {
  const virtualKeyId = await transactor.run(({ memberGatewayKeys }) =>
    memberGatewayKeys.virtualKeyOf(workspaceId, memberId),
  )
  return virtualKeyId && gateway.virtualKeyValue(virtualKeyId)
}

import { type AiProviderAllowList, isAllowedModel, requirePermissionIn } from '@spyria/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { allowListSummaryOf, checkedAllowList } from '../domain/ai-providers.ts'

type Dependencies = { transactor: ProfileTransactor }

export const setAiProviders = (
  { transactor }: Dependencies,
  { allowList }: { allowList: AiProviderAllowList | null },
) =>
  transactor.run(async ({ members, aiProviders, workspaceEvents }) => {
    requirePermissionIn(await members.permissions(), 'providers.manage')
    const checked = checkedAllowList(allowList)
    await aiProviders.setAllowList(checked)
    await workspaceEvents.record({
      workspaceId: transactor.member.workspaceId,
      type: 'ai_providers.changed',
      payload: { allowed: allowListSummaryOf(checked) },
    })
  })

export const isModelAllowed = ({ transactor }: Dependencies, { model }: { model: string | undefined }) =>
  transactor.run(async ({ aiProviders }) => {
    const allowList = await aiProviders.allowList()
    return allowList === null || (model !== undefined && isAllowedModel(allowList, model))
  })

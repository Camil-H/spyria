import type { WorkspaceId } from '@spyria/kernel'
import type { SpendBucketCounts, SpendReport } from '../domain/spend.ts'
import { succeeded } from './http-audit-log.ts'

export const spendPath = '/api/spend'
export const ownSpendPath = `${spendPath}/mine`
export const spendTrendPath = `${spendPath}/trend`
export const ownSpendTrendPath = `${ownSpendPath}/trend`

type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>
type SpendRequest = { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }

export const createHttpSpendCommands = (getAsMember: GetAsMember) => {
  const read =
    <Answer>(path: string) =>
    async ({ workspaceId, search }: SpendRequest) =>
      (await (
        await succeeded(await getAsMember(workspaceId, `${path}?${new URLSearchParams(search)}`))
      ).json()) as Answer
  return {
    readWorkspaceSpend: read<SpendReport>(spendPath),
    readOwnSpend: read<SpendReport>(ownSpendPath),
    readWorkspaceSpendTrend: read<SpendBucketCounts[]>(spendTrendPath),
    readOwnSpendTrend: read<SpendBucketCounts[]>(ownSpendTrendPath),
  }
}

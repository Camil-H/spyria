import type { WorkspaceId } from '@spyria/kernel'
import type { SpendReport } from '../domain/spend.ts'
import { succeeded } from './http-audit-log.ts'

export const spendPath = '/api/spend'
export const ownSpendPath = `${spendPath}/mine`

type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>
type SpendRequest = { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }

export const createHttpSpendCommands = (getAsMember: GetAsMember) => {
  const reportOf =
    (path: string) =>
    async ({ workspaceId, search }: SpendRequest) =>
      (await (
        await succeeded(await getAsMember(workspaceId, `${path}?${new URLSearchParams(search)}`))
      ).json()) as SpendReport
  return { readWorkspaceSpend: reportOf(spendPath), readOwnSpend: reportOf(ownSpendPath) }
}

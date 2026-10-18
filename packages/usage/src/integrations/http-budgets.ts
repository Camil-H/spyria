import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { BudgetOverview, BudgetProgress } from '../domain/budgets.ts'
import { succeeded } from './http-audit-log.ts'

export const budgetsPath = '/api/budgets'
export const ownBudgetPath = `${budgetsPath}/mine`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const overviewOf = async (response: Response) => (await (await succeeded(response)).json()) as BudgetOverview

export const createHttpBudgetCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readBudgets: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    overviewOf(await getAsMember(workspaceId, budgetsPath)),
  saveBudget: async ({
    workspaceId,
    memberId,
    dollars,
  }: {
    workspaceId: WorkspaceId
    memberId: MemberId | null
    dollars: number | null
  }) => overviewOf(await postAsMember(workspaceId, budgetsPath, JSON.stringify({ memberId, dollars }))),
  readOwnBudget: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    (await (await succeeded(await getAsMember(workspaceId, ownBudgetPath))).json()) as BudgetProgress,
})

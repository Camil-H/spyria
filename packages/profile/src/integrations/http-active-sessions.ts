import type { WorkspaceId } from '@spyria/kernel'
import type { ActiveSession } from '../domain/active-session.ts'
import { throwOnRefusal } from './http-refusal.ts'

type RequestAsMember = (workspaceId: WorkspaceId, path: string, method: string) => Promise<Response>
type Input = { workspaceId: WorkspaceId }

export const createHttpActiveSessions = (requestAsMember: RequestAsMember) => ({
  readActiveSessions: async ({ workspaceId }: Input) => {
    const response = await requestAsMember(workspaceId, '/auth/active-sessions', 'GET')
    await throwOnRefusal(response, 'Reading your sessions')
    return ((await response.json()) as { sessions: ActiveSession[] }).sessions
  },
  signOutEverywhere: async ({ workspaceId }: Input) => {
    const response = await requestAsMember(workspaceId, '/auth/sign-out-everywhere', 'POST')
    await throwOnRefusal(response, 'Signing out everywhere')
  },
})

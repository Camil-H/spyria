import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ConnectionInput } from '../domain/workspace-connection.ts'
import { throwOnRefusal } from './http-refusal.ts'

export const workspaceConnectionsPath = '/api/workspace-connections'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type Target = { workspaceId: WorkspaceId; connectionId: string }

export const createHttpWorkspaceConnections = (postAsMember: PostAsMember) => {
  const post = async (workspaceId: WorkspaceId, path: string, body: object = {}) => {
    const response = await postAsMember(workspaceId, `${workspaceConnectionsPath}${path}`, JSON.stringify(body))
    await throwOnRefusal(response, 'The workspace connection request')
  }
  return {
    addWorkspaceConnection: ({ workspaceId, ...connection }: ConnectionInput & { workspaceId: WorkspaceId }) =>
      post(workspaceId, '', connection),
    editWorkspaceConnection: ({ workspaceId, connectionId, ...connection }: Target & ConnectionInput) =>
      post(workspaceId, `/${connectionId}/edit`, connection),
    removeWorkspaceConnection: ({ workspaceId, connectionId }: Target) => post(workspaceId, `/${connectionId}/remove`),
    allowConnectionTools: ({ workspaceId, connectionId, allowedTools }: Target & { allowedTools: string[] }) =>
      post(workspaceId, `/${connectionId}/tools`, { allowedTools }),
    restrictConnectionMember: ({
      workspaceId,
      connectionId,
      ...restriction
    }: Target & { memberId: MemberId; allowedTools: string[] | null }) =>
      post(workspaceId, `/${connectionId}/restrict`, restriction),
  }
}

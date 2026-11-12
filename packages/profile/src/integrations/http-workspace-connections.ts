import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { type ConnectionInput, connectionSignIns } from '../domain/workspace-connection.ts'
import { throwOnRefusal } from './http-refusal.ts'
import { signInThroughPopup } from './http-tool-connections.ts'

export const workspaceConnectionsPath = '/api/workspace-connections'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type Target = { workspaceId: WorkspaceId; connectionId: string }
type Added = { connectionId: string; authorizeUrl?: string }
type Started = Required<Added>

export const createHttpWorkspaceConnections = (postAsMember: PostAsMember) => {
  const post = async (workspaceId: WorkspaceId, path: string, body: object = {}) => {
    const response = await postAsMember(workspaceId, `${workspaceConnectionsPath}${path}`, JSON.stringify(body))
    await throwOnRefusal(response, 'The workspace connection request')
    return response.status === 201 ? ((await response.json()) as Added) : undefined
  }
  const addWithMemberSignIn = async (workspaceId: WorkspaceId, connection: ConnectionInput) => {
    const { connectionId } = await signInThroughPopup(async () => (await post(workspaceId, '', connection)) as Started)
    await post(workspaceId, `/${connectionId}/finish`)
  }
  return {
    addWorkspaceConnection: ({ workspaceId, ...connection }: ConnectionInput & { workspaceId: WorkspaceId }) =>
      connection.signIn === connectionSignIns.member
        ? addWithMemberSignIn(workspaceId, connection)
        : post(workspaceId, '', connection),
    editWorkspaceConnection: ({ workspaceId, connectionId, ...connection }: Target & Omit<ConnectionInput, 'signIn'>) =>
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

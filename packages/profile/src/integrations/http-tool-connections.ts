import type { WorkspaceId } from '@spyria/kernel'
import { throwOnRefusal } from './http-refusal.ts'
import { signInThroughWindow } from './sign-in-window.ts'

export const toolConnectionsPath = '/api/tool-connections'
export const toolConsentChannel = 'spyria-tool-consent'

type RequestAsMember = (workspaceId: WorkspaceId, path: string, method: string) => Promise<Response>
type ToolInput = { workspaceId: WorkspaceId; tool: string }

export const createHttpToolConnections = (requestAsMember: RequestAsMember) => {
  const call = async (workspaceId: WorkspaceId, path: string, method = 'POST') => {
    const response = await requestAsMember(workspaceId, `${toolConnectionsPath}${path}`, method)
    await throwOnRefusal(response, 'The tool connection request')
    return response.status === 204 ? undefined : response.json()
  }
  const toolPath = (tool: string, action: string) => `/${encodeURIComponent(tool)}/${action}`
  return {
    connectTool: async ({ workspaceId, tool }: ToolInput) => {
      await signInThroughWindow(
        toolConsentChannel,
        async () => (await call(workspaceId, toolPath(tool, 'connect'))) as { authorizeUrl: string },
      )
      return call(workspaceId, toolPath(tool, 'refresh'))
    },
    disconnectTool: ({ workspaceId, tool }: ToolInput) => call(workspaceId, toolPath(tool, 'disconnect')),
    checkTools: ({ workspaceId }: { workspaceId: WorkspaceId }) => call(workspaceId, '/check'),
  }
}

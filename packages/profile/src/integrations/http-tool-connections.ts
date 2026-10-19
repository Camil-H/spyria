import type { WorkspaceId } from '@spyria/kernel'
import { throwOnRefusal } from './http-refusal.ts'

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
  return {
    availableTools: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
      ((await call(workspaceId, '', 'GET')) as { available: string[] }).available,
    connectTool: async ({ workspaceId, tool }: ToolInput) => {
      const popup = open('about:blank', toolConsentChannel, 'popup,width=520,height=720')
      const consent = new BroadcastChannel(toolConsentChannel)
      const finished = new Promise((resolve) => consent.addEventListener('message', resolve, { once: true }))
      try {
        const { authorizeUrl } = (await call(workspaceId, `/${tool}/connect`)) as { authorizeUrl: string }
        if (popup) popup.location.href = authorizeUrl
        else location.assign(authorizeUrl)
        await finished
      } catch (error) {
        popup?.close()
        throw error
      } finally {
        consent.close()
      }
      return call(workspaceId, `/${tool}/refresh`)
    },
    disconnectTool: ({ workspaceId, tool }: ToolInput) => call(workspaceId, `/${tool}/disconnect`),
  }
}

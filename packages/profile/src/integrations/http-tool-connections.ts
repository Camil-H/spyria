import type { WorkspaceId } from '@spyria/kernel'
import { throwOnRefusal } from './http-refusal.ts'

export const toolConnectionsPath = '/api/tool-connections'
export const toolConsentChannel = 'spyria-tool-consent'

type RequestAsMember = (workspaceId: WorkspaceId, path: string, method: string) => Promise<Response>
type ToolInput = { workspaceId: WorkspaceId; tool: string }

export const signInThroughPopup = async <Started extends { authorizeUrl: string }>(
  startSignIn: () => Promise<Started>,
) => {
  const popup = open('about:blank', toolConsentChannel, 'popup,width=520,height=720')
  const consent = new BroadcastChannel(toolConsentChannel)
  const finished = new Promise((resolve) => consent.addEventListener('message', resolve, { once: true }))
  try {
    const started = await startSignIn()
    if (popup) popup.location.href = started.authorizeUrl
    else location.assign(started.authorizeUrl)
    await finished
    return started
  } catch (error) {
    popup?.close()
    throw error
  } finally {
    consent.close()
  }
}

export const createHttpToolConnections = (requestAsMember: RequestAsMember) => {
  const call = async (workspaceId: WorkspaceId, path: string, method = 'POST') => {
    const response = await requestAsMember(workspaceId, `${toolConnectionsPath}${path}`, method)
    await throwOnRefusal(response, 'The tool connection request')
    return response.status === 204 ? undefined : response.json()
  }
  const toolPath = (tool: string, action: string) => `/${encodeURIComponent(tool)}/${action}`
  return {
    connectTool: async ({ workspaceId, tool }: ToolInput) => {
      await signInThroughPopup(
        async () => (await call(workspaceId, toolPath(tool, 'connect'))) as { authorizeUrl: string },
      )
      return call(workspaceId, toolPath(tool, 'refresh'))
    },
    disconnectTool: ({ workspaceId, tool }: ToolInput) => call(workspaceId, toolPath(tool, 'disconnect')),
    checkTools: ({ workspaceId }: { workspaceId: WorkspaceId }) => call(workspaceId, '/check'),
  }
}

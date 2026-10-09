import { isDecisionModel, type ListedModel, type MemberId, type WorkspaceId } from '@hq/kernel'
import type { AgentChat, SessionClassifier } from '../contracts/agent.ts'

export const createGatewaySessionClassifier = ({
  gatewayUrl,
  virtualKeyOf,
  headersOf,
  timeoutMilliseconds = 3000,
  listedModels,
}: {
  listedModels(): readonly ListedModel[]
  gatewayUrl: () => string
  timeoutMilliseconds?: number
  virtualKeyOf(workspaceId: WorkspaceId, memberId: MemberId): Promise<string | null | undefined>
  headersOf?: (chat: AgentChat) => Record<string, string>
}): SessionClassifier => ({
  listedModels,
  classify: async ({ chat, prompterId, ownerId, model, request }) => {
    try {
      const virtualKey = await virtualKeyOf(chat.workspaceId, prompterId)
      if (!virtualKey) return undefined
      const response = await fetch(`${gatewayUrl()}/v1/${isDecisionModel(model) ? 'decisions' : 'chat/completions'}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${virtualKey}`,
          'content-type': 'application/json',
          'x-bf-dim-chat': chat.chatId,
          'x-bf-dim-prompter': prompterId,
          'x-bf-dim-owner': ownerId ?? '',
          'x-bf-dim-workspace': chat.workspaceId,
          'x-bf-dim-role': 'router',
          'x-bf-mcp-include-clients': '',
          ...headersOf?.(chat),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMilliseconds),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      return {
        body,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      }
    } catch {
      return undefined
    }
  },
})

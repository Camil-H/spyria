import { isDecisionModel, type ListedModel, type MemberId, type WorkspaceId } from '@spyria/kernel'
import type { AgentChat, SessionClassifier } from '../contracts/agent.ts'

const failureByErrorName: Record<string, string> = { TimeoutError: 'timeout', SyntaxError: 'unparseable reply' }

export const createGatewaySessionClassifier = ({
  gatewayUrl,
  virtualKeyOf,
  isBudgetUsedUp,
  headersOf,
  timeoutMilliseconds = 3000,
  listedModels,
}: {
  listedModels(): readonly ListedModel[]
  gatewayUrl: () => string
  timeoutMilliseconds?: number
  virtualKeyOf(workspaceId: WorkspaceId, memberId: MemberId): Promise<string | null | undefined>
  isBudgetUsedUp?(workspaceId: WorkspaceId, memberId: MemberId): Promise<boolean>
  headersOf?: (chat: AgentChat) => Record<string, string>
}): SessionClassifier => ({
  listedModels,
  classify: async ({ chat, prompterId, ownerId, model, request }) => {
    try {
      if (await isBudgetUsedUp?.(chat.workspaceId, prompterId)) return { failure: 'monthly AI budget used up' }
      const virtualKey = await virtualKeyOf(chat.workspaceId, prompterId)
      if (!virtualKey) return { failure: 'no gateway key' }
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
      if (!response.ok) return { failure: `HTTP ${response.status}` }
      const body = (await response.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      return {
        body,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return { failure: failureByErrorName[name] ?? 'unreachable' }
    }
  },
})

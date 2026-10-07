import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { AgentChat, SessionClassifier } from '../contracts/agent.ts'

const classifierTimeoutMilliseconds = 3000

export const createGatewaySessionClassifier = ({
  gatewayUrl,
  virtualKeyOf,
  headersOf,
}: {
  gatewayUrl: () => string
  virtualKeyOf(workspaceId: WorkspaceId, memberId: MemberId): Promise<string | null | undefined>
  headersOf?: (chat: AgentChat) => Record<string, string>
}): SessionClassifier => ({
  classify: async ({ chat, prompterId, ownerId, request }) => {
    try {
      const virtualKey = await virtualKeyOf(chat.workspaceId, prompterId)
      if (!virtualKey) return undefined
      const response = await fetch(`${gatewayUrl()}/v1/chat/completions`, {
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
        signal: AbortSignal.timeout(classifierTimeoutMilliseconds),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      return {
        content: body.choices?.[0]?.message?.content ?? '',
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      }
    } catch {
      return undefined
    }
  },
})

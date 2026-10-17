import type { ChatId, WorkspaceId } from '@hq/kernel'

export const commandOutputPathOf = (chatId: string, stepId: string) => `/api/chats/${chatId}/steps/${stepId}/output`
export const chatRoutingPathOf = (chatId: string) => `/api/chats/${chatId}/routing`
export const chatQuestionPathOf = (chatId: string, questionId: string) => `/api/chats/${chatId}/questions/${questionId}`
export const chatPlanModePathOf = (chatId: string) => `/api/chats/${chatId}/plan-mode`

const storedChatWaitMilliseconds = 5000
const storedChatRetryMilliseconds = 100

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>
type ChatInput = { workspaceId: WorkspaceId; chatId: ChatId }

export const createHttpChatCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  commandOutput: async ({ workspaceId, chatId, stepId }: ChatInput & { stepId: string }) => {
    const response = await getAsMember(workspaceId, commandOutputPathOf(chatId, stepId))
    if (!response.ok) throw new Error(`The command output read answered ${response.status}`)
    return response.text()
  },
  chatRouting: async ({ workspaceId, chatId }: ChatInput) => {
    for (let waited = 0; ; waited += storedChatRetryMilliseconds) {
      const response = await getAsMember(workspaceId, chatRoutingPathOf(chatId))
      if (response.ok) return response.json()
      if (waited >= storedChatWaitMilliseconds) throw new Error(`The routing read answered ${response.status}`)
      await new Promise((resolve) => setTimeout(resolve, storedChatRetryMilliseconds))
    }
  },
  answerQuestion: async ({
    workspaceId,
    chatId,
    questionId,
    answer,
  }: ChatInput & { questionId: string; answer: object }) =>
    (await postAsMember(workspaceId, chatQuestionPathOf(chatId, questionId), JSON.stringify(answer))).status,
  setPlanMode: async ({ workspaceId, chatId, enabled }: ChatInput & { enabled: boolean }) =>
    (await postAsMember(workspaceId, chatPlanModePathOf(chatId), JSON.stringify({ enabled }))).status,
})

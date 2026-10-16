import type { ChatId, WorkspaceId } from '@hq/kernel'

export const commandOutputPathOf = (chatId: string, stepId: string) => `/api/chats/${chatId}/steps/${stepId}/output`
export const chatRoutingPathOf = (chatId: string) => `/api/chats/${chatId}/routing`
export const chatQuestionPathOf = (chatId: string, questionId: string) => `/api/chats/${chatId}/questions/${questionId}`
export const chatPlanModePathOf = (chatId: string) => `/api/chats/${chatId}/plan-mode`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>
type ChatInput = { workspaceId: WorkspaceId; chatId: ChatId }

export const createHttpChatCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  commandOutput: async ({ workspaceId, chatId, stepId }: ChatInput & { stepId: string }) =>
    (await getAsMember(workspaceId, commandOutputPathOf(chatId, stepId))).text(),
  chatRouting: async ({ workspaceId, chatId }: ChatInput) =>
    (await getAsMember(workspaceId, chatRoutingPathOf(chatId))).json(),
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

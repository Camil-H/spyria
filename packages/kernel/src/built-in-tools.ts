import {
  accessLevels,
  type ConnectionTool,
  type ToolApprovalPreference,
  type ToolHolder,
  type ToolServerAccess,
  toolApprovalOf,
  toolsAllowedBy,
} from './tool-access.ts'

export const builtInFeatures = { browser: 'browser', qualityGates: 'quality_gates' } as const
export type BuiltInFeature = (typeof builtInFeatures)[keyof typeof builtInFeatures]
export type BuiltInTool = ConnectionTool & Readonly<{ summary: string; feature: BuiltInFeature | null }>
export type GitHubTool = ConnectionTool & Readonly<{ summary: string }>

const builtInTool = (name: string, readOnly: boolean, summary: string, feature: BuiltInFeature | null = null) => ({
  name,
  readOnly,
  destructive: false,
  summary,
  feature,
})

export const builtInTools: readonly BuiltInTool[] = [
  builtInTool(
    'open_page',
    true,
    "Opens a web page or a file of the project in the chat's Browser tab",
    builtInFeatures.browser,
  ),
  builtInTool(
    'take_screenshot',
    true,
    'Takes a screenshot of a web page, such as the app running in the runtime',
    builtInFeatures.browser,
  ),
  builtInTool('web_search', true, 'Searches the web with a model of the member who prompted, on their key and budget'),
  builtInTool('list_public_chats', true, "Lists the workspace's public channels and AI chats"),
  builtInTool('search_public_chats', true, "Searches the messages of the workspace's public channels and AI chats"),
  builtInTool('read_public_chat', true, 'Reads the messages of a public channel or AI chat'),
  builtInTool('delegate', false, "Hands a task to a subagent that shares the runtime's files"),
  builtInTool('await_task', true, 'Waits for a task handed to a subagent'),
  builtInTool('check_task', false, 'Reads the steps of a task handed to a subagent, or stops it'),
  builtInTool(
    'finish_work',
    false,
    'Hands the finished work of a dev chat to the quality gates',
    builtInFeatures.qualityGates,
  ),
  builtInTool(
    'report_review',
    false,
    "Reports the findings of the quality gates' code review",
    builtInFeatures.qualityGates,
  ),
]

export const githubConnectionId = 'github'
export const githubServerName = 'GitHub'

const githubReadTool = (name: string, summary: string): GitHubTool => ({
  name,
  summary,
  readOnly: true,
  destructive: false,
})
const githubWriteTool = (name: string, summary: string): GitHubTool => ({
  name,
  summary,
  readOnly: false,
  destructive: false,
})

export const githubTools: readonly GitHubTool[] = [
  githubWriteTool('push_branch', "Pushes the chat's working branch, fast-forward only"),
  githubWriteTool('open_pull_request', 'Pushes, then opens a pull request into the base branch'),
  githubWriteTool('update_pull_request', "Changes the title or the description of the chat's open pull request"),
  githubReadTool('fetch_branch', 'Fetches a branch of the repository into the runtime'),
  githubReadTool('read_review_threads', "Reads a pull request's review threads"),
  githubReadTool('read_checks', "Reads the checks of a pull request's head commit, failing first"),
  githubReadTool('list_issues', 'Lists issues of the repository'),
  githubReadTool('read_issue', 'Reads an issue with its comments'),
]

const githubServer = { signIn: 'member' } as const

export const githubRoleAccessOf = (roleId: string, accessRows: readonly ToolServerAccess[]): ToolServerAccess =>
  accessRows.find((access) => access.connectionId === githubConnectionId && access.roleId === roleId) ?? {
    connectionId: githubConnectionId,
    roleId,
    level: accessLevels.write,
    toolChanges: {},
  }

export const githubAccessOf = (accessRows: readonly ToolServerAccess[], holder: ToolHolder): ToolServerAccess =>
  githubRoleAccessOf(holder.roleId, accessRows)

export const githubToolsOf = (accessRows: readonly ToolServerAccess[], holder: ToolHolder) =>
  toolsAllowedBy(githubTools, githubAccessOf(accessRows, holder)).map(({ name }) => name)

export const isGitHubTool = (name: string) => githubTools.some((tool) => tool.name === name)

export const isReadOnlyGitHubTool = (name: string) => githubTools.some((tool) => tool.name === name && tool.readOnly)

export const githubToolApprovalOf = (name: string, preference?: ToolApprovalPreference) => {
  const tool = githubTools.find((githubTool) => githubTool.name === name)
  return tool ? toolApprovalOf(githubServer, tool, preference) : undefined
}

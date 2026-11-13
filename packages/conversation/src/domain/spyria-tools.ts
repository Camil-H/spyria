import { openPageTool } from './browser-pages.ts'
import { publicChatTools } from './public-chats.ts'
import { takeScreenshotTool } from './screenshots.ts'

export const spyriaToolsPath = '/mcp/spyria'
export const catalogueToolsPath = '/mcp'
export const spyriaCommandInstructions =
  'The services this workspace connected are also reachable from the shell: run `spyria` to list them and `spyria <service> --help` for their tools.'
export const spyriaTools = [openPageTool, takeScreenshotTool, ...publicChatTools]
export const isSpyriaTool = (name: string) => spyriaTools.some((tool) => tool.name === name)
export const isReadOnlySpyriaTool = (name: string) => publicChatTools.some((tool) => tool.name === name)

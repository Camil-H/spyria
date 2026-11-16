import { openPageTool } from './browser-pages.ts'
import {
  browserNavigateTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserTools,
  browserWaitTool,
} from './browser-tools.ts'
import { publicChatTools } from './public-chats.ts'
import { takeScreenshotTool } from './screenshots.ts'

export const spyriaToolsPath = '/mcp/spyria'
export const catalogueToolsPath = '/mcp'
export const spyriaCommandInstructions =
  'The services this workspace connected are also reachable from the shell: run `spyria` to list them and `spyria <service> --help` for their tools.'
export const spyriaTools = [openPageTool, ...browserTools, takeScreenshotTool, ...publicChatTools]
export const isSpyriaTool = (name: string) => spyriaTools.some((tool) => tool.name === name)
const readOnlyTools = [
  openPageTool,
  browserSnapshotTool,
  browserWaitTool,
  browserNavigateTool,
  browserScreenshotTool,
  takeScreenshotTool,
  ...publicChatTools,
]
export const isReadOnlySpyriaTool = (name: string) => readOnlyTools.some((tool) => tool.name === name)

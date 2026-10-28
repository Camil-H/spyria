import { openPageTool } from './browser-pages.ts'
import { takeScreenshotTool } from './screenshots.ts'

export const spyriaTools = [openPageTool, takeScreenshotTool]
export const isSpyriaTool = (name: string) => spyriaTools.some((tool) => tool.name === name)

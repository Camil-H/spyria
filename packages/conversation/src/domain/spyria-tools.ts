import { openPageTool } from './browser-pages.ts'

export const spyriaTools = [openPageTool]
export const isSpyriaTool = (name: string) => spyriaTools.some((tool) => tool.name === name)

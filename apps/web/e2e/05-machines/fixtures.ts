import type { Page } from '@playwright/test'
import { mainOf } from '../fixtures.ts'
import { viteUrl } from '../stack-ports.ts'

export * from '../fixtures.ts'

export const machineSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My machine' })
export const machineToolOf = (page: Page, toolName: string) =>
  machineSectionOf(page).getByRole('button', { name: new RegExp(`^(Use ${toolName}|✓ ${toolName} connected)$`) })
export const urlOf = (command: string) => `${viteUrl}/h/${command.match(/\/h\/([A-Z0-9]{8})\b/)?.[1]}`

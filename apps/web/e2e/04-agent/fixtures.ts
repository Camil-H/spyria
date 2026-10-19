import { expect } from '@playwright/test'
import type { WorkerStack } from '../stack.ts'

export * from '../fixtures.ts'

export const newSessionNotice = 'The agent started a new session; it does not remember earlier messages'
export const delegationsFinished = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(async () =>
      (await workerStack.database.$client`select status from delegations where chat_id = ${chatId}`).map(
        ({ status }) => status,
      ),
    )
    .toEqual(['finished'])

import type { Brand } from '@hq/kernel'
import { BlankMessageBody } from './errors.ts'

export type MessageBody = Brand<'MessageBody'>

export const MessageBody = (rawValue: string): MessageBody => {
  const trimmedValue = rawValue.trim()
  if (trimmedValue === '') throw new BlankMessageBody()
  return trimmedValue as MessageBody
}

const chatNameMaxLength = 60

export const chatNameFrom = (body: MessageBody): string => {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > chatNameMaxLength ? `${firstLine.slice(0, chatNameMaxLength)}…` : firstLine
}

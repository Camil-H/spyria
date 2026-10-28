import { type Brand, nonBlank } from '@spyria/kernel'
import { BlankMessageBody } from './errors.ts'

export type MessageBody = Brand<'MessageBody'>

export const MessageBody = (rawValue: string, { allowsBlank = false } = {}) =>
  (allowsBlank ? rawValue.trim() : nonBlank(rawValue, BlankMessageBody)) as MessageBody

const chatNameMaxLength = 60

export const chatNameFrom = (body: MessageBody, fallback = ''): string => {
  const firstLine = body.split('\n', 1)[0]?.trim() || fallback
  return firstLine.length > chatNameMaxLength ? `${firstLine.slice(0, chatNameMaxLength)}…` : firstLine
}

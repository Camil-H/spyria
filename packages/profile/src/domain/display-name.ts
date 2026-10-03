import type { Brand } from '@hq/kernel'
import { BlankDisplayName } from './errors.ts'

export type DisplayName = Brand<'DisplayName'>

export const DisplayName = (rawValue: string): DisplayName => {
  const trimmedValue = rawValue.trim()
  if (trimmedValue === '') throw new BlankDisplayName()
  return trimmedValue as DisplayName
}

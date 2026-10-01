import type { Brand } from '@hq/kernel'
import { BlankName } from './errors.ts'

export type Name = Brand<'Name'>

export const Name = (rawValue: string): Name => {
  const trimmedValue = rawValue.trim()
  if (trimmedValue === '') throw new BlankName()
  return trimmedValue as Name
}

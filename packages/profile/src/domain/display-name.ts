import { type Brand, nonBlank } from '@spyria/kernel'
import { BlankDisplayName } from './errors.ts'

export type DisplayName = Brand<'DisplayName'>

export const DisplayName = (rawValue: string) => nonBlank(rawValue, BlankDisplayName) as DisplayName

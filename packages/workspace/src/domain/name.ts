import { type Brand, nonBlank } from '@spyria/kernel'
import { BlankName } from './errors.ts'

export type Name = Brand<'Name'>

export const Name = (rawValue: string) => nonBlank(rawValue, BlankName) as Name

import { type Brand, nonBlank } from '@spyria/kernel'
import { BlankHostName, HostNameTooLong } from './errors.ts'

export type HostName = Brand<'HostName'>

const maximumLength = 60

export const HostName = (rawName: string) => {
  const name = nonBlank(rawName, BlankHostName)
  if (name.length > maximumLength) throw new HostNameTooLong()
  return name as HostName
}

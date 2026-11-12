import { TooManyToolServersOff } from './errors.ts'

const maximumToolServersOff = 100
export const toolServerNamePattern = /^[a-z0-9_]{1,100}$/

export const toolServersOffAfter = (off: readonly string[], server: string, isOn: boolean) => {
  if (isOn) return off.filter((name) => name !== server)
  if (off.includes(server)) return off
  if (off.length >= maximumToolServersOff) throw new TooManyToolServersOff()
  return [...off, server]
}

export const includedToolServersOf = (catalogue: readonly string[], off: readonly string[]) =>
  catalogue.filter((server) => !off.includes(server))

export const toolServerOffNoticeOf = (serverName: string) => `${serverName} is off for this chat`

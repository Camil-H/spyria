import { TooManyToolServersOff } from './errors.ts'

type CatalogueServer = Readonly<{ id: string; gatewayName: string }>

const maximumToolServersOff = 100
export const toolServerIdPattern = /^[A-Za-z0-9-]{1,100}$/

export const toolServersOffAfter = (off: readonly string[], connectionId: string, isOn: boolean) => {
  if (isOn) return off.filter((id) => id !== connectionId)
  if (off.includes(connectionId)) return off
  if (off.length >= maximumToolServersOff) throw new TooManyToolServersOff()
  return [...off, connectionId]
}

export const switchedToolServersOf = (catalogue: readonly CatalogueServer[], off: readonly string[]) => ({
  on: catalogue.filter(({ id }) => !off.includes(id)).map(({ gatewayName }) => gatewayName),
  off: catalogue.filter(({ id }) => off.includes(id)).map(({ gatewayName }) => gatewayName),
})

export const toolServerOffNoticeOf = (serverName: string) => `${serverName} is off for this chat`

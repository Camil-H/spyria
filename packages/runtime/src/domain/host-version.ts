export const minimumHostProtocol = 1

type Versioned = { hostVersion: string | null; protocolVersion: number }

export const isHostOutOfDate = (protocolVersion: number) => protocolVersion < minimumHostProtocol

export const hostUpdateOf = (host: Versioned, serverVersion: string) => {
  if (host.hostVersion === null) return undefined
  if (isHostOutOfDate(host.protocolVersion)) return 'needed'
  return host.hostVersion === serverVersion ? undefined : 'available'
}

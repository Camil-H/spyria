export const minimumHostProtocol = 4

type Versioned = {
  status: 'waiting' | 'online' | 'offline' | 'expired'
  hostVersion: string | null
  protocolVersion: number
}

export const isHostOutOfDate = (protocolVersion: number) => protocolVersion < minimumHostProtocol

export const hostUpdateOf = (host: Versioned, serverVersion: string) => {
  if (host.status === 'waiting' || host.status === 'expired') return undefined
  if (isHostOutOfDate(host.protocolVersion)) return 'needed'
  return host.hostVersion === null || host.hostVersion === serverVersion ? undefined : 'available'
}

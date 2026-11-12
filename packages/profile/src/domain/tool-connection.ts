export const connectionStatuses = { connected: 'Connected', needsReconnection: 'Needs reconnection' } as const
export type ConnectionStatus = (typeof connectionStatuses)[keyof typeof connectionStatuses]
export const notConnectedStatus = 'Not connected'

export type ToolConnection = Readonly<{ connectionId: string; status: ConnectionStatus }>

export const connectionStatusOf = (sessionStatuses: readonly string[]) =>
  sessionStatuses.includes('active')
    ? connectionStatuses.connected
    : sessionStatuses.includes('needs_reauth')
      ? connectionStatuses.needsReconnection
      : undefined

export const checkedConnectionStatusOf = ({
  sessionStatus,
  isAuthorized,
  storedStatus,
}: {
  sessionStatus: ConnectionStatus | undefined
  isAuthorized: boolean | undefined
  storedStatus: string | undefined
}) => {
  if (sessionStatus !== connectionStatuses.connected) return sessionStatus
  if (isAuthorized === undefined && storedStatus === connectionStatuses.needsReconnection) return storedStatus
  return isAuthorized === false ? connectionStatuses.needsReconnection : connectionStatuses.connected
}

type Environment = Record<string, string | undefined>

const proxyVariables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']

const isExcluded = (hostname: string, noProxy: string) =>
  noProxy
    .split(',')
    .map((entry) =>
      entry
        .trim()
        .replace(/:\d+$/, '')
        .replace(/^\*?\./, '')
        .toLowerCase(),
    )
    .filter(Boolean)
    .some((entry) => entry === '*' || hostname === entry || hostname.endsWith(`.${entry}`))

export const proxyOf = (url: URL, environment: Environment) => {
  const isSecure = url.protocol === 'wss:' || url.protocol === 'https:'
  const proxy = isSecure
    ? (environment.HTTPS_PROXY ?? environment.https_proxy)
    : (environment.HTTP_PROXY ?? environment.http_proxy)
  const noProxy = environment.NO_PROXY ?? environment.no_proxy ?? ''
  return proxy && !isExcluded(url.hostname.toLowerCase(), noProxy) ? proxy : undefined
}

export const takeProxySettings = (environment: Environment) => {
  const settings = Object.fromEntries(proxyVariables.map((name) => [name, environment[name]]))
  for (const name of proxyVariables) delete environment[name]
  return settings
}

type BunWebSocket = new (url: URL, options: Bun.WebSocketOptions) => WebSocket

export const webSocketThrough = (proxy: string | undefined, url: URL) =>
  new (WebSocket as unknown as BunWebSocket)(url, { proxy })

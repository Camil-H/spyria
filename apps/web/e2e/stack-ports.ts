export const serverUrl = 'http://localhost:3100'
export const viteUrl = 'http://localhost:5190'
export const zeroCachePortOf = (workerIndex: number) => 4900 + 2 * workerIndex
export const maximumWorkerCount = 8
export const templateDatabaseName = 'spyria_e2e_template'
export const gatewayPort = 4881
export const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
export const fakeMcpUrl = 'http://localhost:3101'
export const ssoServerUrl = 'http://localhost:3102'
export const ssoViteUrl = 'http://localhost:5191'
export const ssoProviderIssuer = 'http://localhost:5557/dex'

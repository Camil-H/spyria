export class DockerError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Mount = { Type: 'volume'; Source: string; Target: string; ReadOnly?: boolean }

export type Docker = <Result = unknown>(method: string, path: string, body?: unknown) => Promise<Result>

export const createDocker =
  (socketPath: string): Docker =>
  async <Result>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://docker${path}`, {
      method,
      unix: socketPath,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok && response.status !== 304)
      throw new DockerError(
        response.status,
        `Docker ${method} ${path.split('?')[0]} failed with ${response.status}: ${text.trim()}`,
      )
    return (text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as Result
  }

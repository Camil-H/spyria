import type { Mount } from './docker.ts'

export const browserKeyPattern = /^[a-f0-9]{32}$/
const gibibyte = 1024 ** 3
const mebibyte = 1024 ** 2
const browserEntrypoint = ['node', '/usr/local/lib/spyria/browser/browser.mjs']
const profileTarget = '/var/lib/spyria/browser'
const attachHeaderBytes = 8
const stdoutStream = 1
export const browserLabel = 'spyria.browser'
export const profileCreatedLabel = 'spyria.browser.created'
export const minimumFreeBytesForBrowser = 768 * mebibyte

export const browserContainerOf = (runtimeContainer: string, browserKey: string) =>
  `${runtimeContainer}-browser-${browserKey}`
export const profileVolumeOf = (browserContainer: string) => `${browserContainer}-profile`

export const browserBodyOf = ({
  runtimeId,
  runtimeContainerId,
  image,
  profileVolume,
}: {
  runtimeId: string
  runtimeContainerId: string
  image: string
  profileVolume: string
}) => ({
  Image: image,
  User: '10001:10001',
  Entrypoint: browserEntrypoint,
  Env: ['HOME=/tmp'],
  OpenStdin: true,
  StdinOnce: false,
  AttachStdin: true,
  AttachStdout: true,
  AttachStderr: false,
  Tty: false,
  Labels: { 'spyria.managed': '1', [browserLabel]: runtimeId },
  HostConfig: {
    Init: true,
    NetworkMode: `container:${runtimeContainerId}`,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    ReadonlyRootfs: true,
    Privileged: false,
    PublishAllPorts: false,
    Memory: gibibyte,
    MemorySwap: gibibyte,
    NanoCpus: 1_000_000_000,
    PidsLimit: 256,
    ShmSize: 256 * mebibyte,
    Tmpfs: { '/tmp': 'size=512m' },
    LogConfig: { Type: 'none', Config: {} },
    RestartPolicy: { Name: 'no' },
    Mounts: [{ Type: 'volume', Source: profileVolume, Target: profileTarget }] satisfies Mount[],
  },
})

export const isProfileExpired = (createdAt: string | undefined, signInHours: number | undefined, now: number) =>
  signInHours !== undefined && now - Number(createdAt ?? 0) >= signInHours * 3_600_000

export const createAttachReader = (onLine: (line: string) => void) => {
  let pending = Buffer.alloc(0)
  let text = ''
  return (chunk: Uint8Array) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= attachHeaderBytes) {
      const size = pending.readUInt32BE(4)
      if (pending.length < attachHeaderBytes + size) return
      const stream = pending[0]
      const payload = pending.subarray(attachHeaderBytes, attachHeaderBytes + size)
      pending = pending.subarray(attachHeaderBytes + size)
      if (stream !== stdoutStream) continue
      text += payload.toString('utf8')
      const lines = text.split('\n')
      text = lines.pop() ?? ''
      for (const line of lines) if (line) onLine(line)
    }
  }
}

export type BrowserStream = { send(line: string): void; close(): void }
export type BrowserStreamListener = { onLine(line: string): void; onClose(): void }

const upgradeRequestOf = (container: string) =>
  `POST /containers/${container}/attach?stream=1&stdin=1&stdout=1&stderr=0 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`

export const attachToBrowser = (socketPath: string, container: string, listener: BrowserStreamListener) =>
  new Promise<BrowserStream>((resolve, reject) => {
    const read = createAttachReader(listener.onLine)
    let head = Buffer.alloc(0)
    let isUpgraded = false
    let isClosed = false
    let unsent = Buffer.alloc(0)
    let flush = () => {}
    const close = () => {
      if (isClosed) return
      isClosed = true
      listener.onClose()
    }
    void Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.write(upgradeRequestOf(container))
        },
        data: (socket, chunk) => {
          if (isUpgraded) return read(chunk)
          head = Buffer.concat([head, chunk])
          const end = head.indexOf('\r\n\r\n')
          if (end < 0) return
          const status = Number(head.subarray(0, end).toString('latin1').split(' ')[1])
          if (status !== 101 && status !== 200) {
            socket.end()
            return reject(new Error(`Attaching to the browser failed with ${status}`))
          }
          isUpgraded = true
          flush = () => {
            unsent = unsent.subarray(socket.write(unsent))
          }
          resolve({
            send: (line) => {
              unsent = Buffer.concat([unsent, Buffer.from(`${line}\n`)])
              flush()
            },
            close: () => socket.end(),
          })
          const rest = head.subarray(end + 4)
          if (rest.length > 0) read(rest)
        },
        drain: () => flush(),
        close,
        error: (_, error) => {
          reject(error)
          close()
        },
        connectError: (_, error) => reject(error),
      },
    }).catch(reject)
  })

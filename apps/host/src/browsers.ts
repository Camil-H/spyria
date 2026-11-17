import type { Mount } from './docker.ts'

export const browserKeyPattern = /^[a-f0-9]{32}$/
export const browserFileIdPattern = /^[a-f0-9]{32}$/
export const browserFilesDirectory = '/var/lib/spyria/browser/files'
const tarBlockBytes = 512
const tarSizeField = [124, 136] as const
const tarTypeField = 156
const regularFileTypes = ['0', '\0']
const gibibyte = 1024 ** 3
const mebibyte = 1024 ** 2
const browserEntrypoint = ['node', '/usr/local/lib/spyria/browser/browser.mjs']
const profileTarget = '/var/lib/spyria/browser'
const attachHeaderBytes = 8
const stdoutStream = 1
export const browserLabel = 'spyria.browser'
export const profileCreatedLabel = 'spyria.browser.created'
export const signInHoursLabel = 'spyria.browser.sign_in_hours'
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

class NotAFile extends Error {
  constructor() {
    super('refused: not a file of the browser')
  }
}

export async function* tarFileContentOf(chunks: AsyncIterable<Uint8Array>) {
  let pending = Buffer.alloc(0)
  let remaining: number | undefined
  for await (const chunk of chunks) {
    pending = Buffer.concat([pending, chunk])
    if (remaining === undefined) {
      if (pending.length < tarBlockBytes) continue
      if (!regularFileTypes.includes(String.fromCharCode(pending[tarTypeField] ?? 0))) throw new NotAFile()
      remaining = Number.parseInt(
        pending
          .subarray(...tarSizeField)
          .toString('latin1')
          .replace(/\0.*$/s, '')
          .trim(),
        8,
      )
      if (!Number.isSafeInteger(remaining)) throw new NotAFile()
      pending = pending.subarray(tarBlockBytes)
    }
    const piece = pending.subarray(0, remaining)
    remaining -= piece.length
    pending = pending.subarray(piece.length)
    if (piece.length > 0) yield piece
    if (remaining === 0) return
  }
  if (remaining !== 0) throw new NotAFile()
}

export const isProfileExpired = (createdAt: string | undefined, signInHours: number | undefined, now: number) =>
  signInHours !== undefined && now - Number(createdAt ?? 0) >= signInHours * 3_600_000

const newline = 0x0a

export const createAttachReader = (onLine: (line: string) => void) => {
  let pending = Buffer.alloc(0)
  let output = Buffer.alloc(0)
  const readLines = () => {
    for (let end = output.indexOf(newline); end >= 0; end = output.indexOf(newline)) {
      if (end > 0) onLine(output.subarray(0, end).toString('utf8'))
      output = output.subarray(end + 1)
    }
  }
  return (chunk: Uint8Array) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= attachHeaderBytes) {
      const size = pending.readUInt32BE(4)
      if (pending.length < attachHeaderBytes + size) return
      const stream = pending[0]
      const payload = pending.subarray(attachHeaderBytes, attachHeaderBytes + size)
      pending = pending.subarray(attachHeaderBytes + size)
      if (stream !== stdoutStream) continue
      output = Buffer.concat([output, payload])
      readLines()
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

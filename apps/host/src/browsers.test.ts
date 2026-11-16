import { afterAll, expect, test } from 'bun:test'
import { attachToBrowser, createAttachReader, isProfileExpired, tarFileContentOf } from './browsers.ts'
import { waitFor } from './testing.ts'

const attachFrameOf = (stream: number, text: string | Buffer) => {
  const payload = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

test("the attach reader keeps the browser's output lines whole across frames and chunks, and drops other streams", () => {
  const lines: string[] = []
  const read = createAttachReader((line) => lines.push(line))
  const bytes = Buffer.concat([
    attachFrameOf(1, '{"type":"ready"}\n{"type":"fra'),
    attachFrameOf(2, 'an error\n'),
    attachFrameOf(1, 'me"}\n'),
  ])
  for (let offset = 0; offset < bytes.length; offset += 5) read(bytes.subarray(offset, offset + 5))
  expect(lines).toEqual(['{"type":"ready"}', '{"type":"frame"}'])
})

test('a character Docker splits between two frames reads whole', () => {
  const lines: string[] = []
  const read = createAttachReader((line) => lines.push(line))
  const title = Buffer.from('{"title":"Café 日本"}\n')
  const cut = title.indexOf(Buffer.from('日')) + 1
  read(Buffer.concat([attachFrameOf(1, title.subarray(0, cut)), attachFrameOf(1, title.subarray(cut))]))
  expect(lines).toEqual(['{"title":"Café 日本"}'])
})

test('sign-ins expire after the lifetime, and never without one', () => {
  const hour = 3_600_000
  expect(isProfileExpired('0', 8, 8 * hour)).toBe(true)
  expect(isProfileExpired('0', 8, 8 * hour - 1)).toBe(false)
  expect(isProfileExpired('0', undefined, 1000 * hour)).toBe(false)
})

const socketPath = `/tmp/spyria-attach-${process.pid}.sock`
const received: string[] = []
const fakeDocker = Bun.listen({
  unix: socketPath,
  socket: {
    data: (socket, data) => {
      const text = Buffer.from(data).toString()
      if (text.startsWith('POST /containers/spyria-rt-1-browser-x/attach?stream=1&stdin=1&stdout=1&stderr=0 ')) {
        socket.write(Buffer.concat([Buffer.from('HTTP/1.1 101 UPGRADED\r\n\r\n'), attachFrameOf(1, 'first\n')]))
        return
      }
      if (text.startsWith('POST ')) return void socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      received.push(text)
      socket.write(attachFrameOf(1, `echo ${text}`))
    },
  },
})
afterAll(() => fakeDocker.stop(true))

test("attaching to a browser reads its output and writes lines to its input through Docker's socket", async () => {
  const lines: string[] = []
  let isClosed = false
  const stream = await attachToBrowser(socketPath, 'spyria-rt-1-browser-x', {
    onLine: (line) => lines.push(line),
    onClose: () => {
      isClosed = true
    },
  })
  stream.send('{"type":"watch"}')
  await waitFor(() => lines.length === 2)
  expect(lines).toEqual(['first', 'echo {"type":"watch"}'])
  expect(received).toEqual(['{"type":"watch"}\n'])
  stream.close()
  await waitFor(() => isClosed)
  expect(isClosed).toBe(true)
})

test('attaching to a container Docker does not know fails', async () => {
  const failure = await attachToBrowser(socketPath, 'missing', { onLine: () => {}, onClose: () => {} }).then(
    () => undefined,
    (error: Error) => error.message,
  )
  expect(failure).toBe('Attaching to the browser failed with 404')
})

const tarOf = (content: Buffer, type = '0') => {
  const header = Buffer.alloc(512)
  header.write('a'.repeat(32), 0, 'latin1')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  header.write(type, 156, 'latin1')
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)])
}
const contentOf = async (bytes: Buffer, pieceBytes: number) => {
  async function* pieces() {
    for (let offset = 0; offset < bytes.length; offset += pieceBytes) yield bytes.subarray(offset, offset + pieceBytes)
  }
  const parts: Uint8Array[] = []
  for await (const part of tarFileContentOf(pieces())) parts.push(part)
  return Buffer.concat(parts)
}

test("a browser's file comes out of Docker's archive whole, without the archive's header or padding, however it is cut", async () => {
  const content = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251))
  for (const pieceBytes of [1, 7, 512, 4096, 100_000])
    expect(await contentOf(tarOf(content), pieceBytes)).toEqual(content)
  expect(await contentOf(tarOf(Buffer.alloc(0)), 512)).toEqual(Buffer.alloc(0))
})

test('an archive that holds a directory, a link or a cut file is refused', async () => {
  for (const type of ['5', '2', 'x'])
    expect(await contentOf(tarOf(Buffer.from('x'), type), 512).catch((error: Error) => error.message)).toBe(
      'refused: not a file of the browser',
    )
  const cut = tarOf(Buffer.alloc(2000, 1)).subarray(0, 1000)
  expect(await contentOf(cut, 512).catch((error: Error) => error.message)).toBe('refused: not a file of the browser')
})

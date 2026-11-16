import { expect, test } from 'bun:test'
import { BrowserUnavailable } from '../domain/errors.ts'
import { browserFileStreamOf } from './browser-file-stream.ts'

type Listener = Parameters<Parameters<typeof browserFileStreamOf>[0]['open']>[0]
const chunkBytes = 192 * 1024
const creditBytes = 1024 * 1024

const hostSending = (totalBytes: number) => {
  let listener: Listener | undefined
  let unacknowledgedBytes = 0
  let handledBytes = 0
  let sentBytes = 0
  let isClosed = false
  const hasCredit = (bytes: number) =>
    unacknowledgedBytes < creditBytes / 2 || unacknowledgedBytes + bytes <= creditBytes
  const acknowledgeHandled = (bytes: number) => {
    handledBytes += bytes
    if (handledBytes < creditBytes / 2) return
    unacknowledgedBytes -= handledBytes
    handledBytes = 0
    queueMicrotask(pump)
  }
  const pump = () => {
    while (!isClosed && sentBytes < totalBytes) {
      const bytes = Math.min(chunkBytes, totalBytes - sentBytes)
      const data = Buffer.alloc(bytes, sentBytes % 251).toString('base64')
      if (!hasCredit(data.length)) return
      sentBytes += bytes
      unacknowledgedBytes += data.length
      const handled = listener?.onMessage(data)
      if (handled instanceof Promise) void handled.then(() => acknowledgeHandled(data.length))
      else acknowledgeHandled(data.length)
    }
    if (!isClosed && sentBytes === totalBytes) {
      isClosed = true
      listener?.onClose()
    }
  }
  return {
    open: (opened: Listener) => {
      listener = opened
      queueMicrotask(pump)
      return {
        close: () => {
          isClosed = true
        },
      }
    },
  }
}

const readSlowly = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  let total = 0
  for (;;) {
    const read = await Promise.race([reader.read(), Bun.sleep(1000).then(() => 'stalled' as const)])
    if (read === 'stalled') return { total, isStalled: true }
    if (read.done) return { total, isStalled: false }
    total += read.value.byteLength
    await Bun.sleep(1)
  }
}

test("a large file reaches a slow reader whole: every chunk held while the reader catches up is acknowledged, so the host's credit never runs dry", async () => {
  const totalBytes = 64 * 1024 * 1024
  let doneCount = 0
  const stream = browserFileStreamOf({
    ...hostSending(totalBytes),
    onDone: () => {
      doneCount += 1
    },
    expectedBytes: totalBytes,
  })
  expect(await readSlowly(stream)).toEqual({ total: totalBytes, isStalled: false })
  expect(doneCount).toBe(1)
})

test('a file the host fails to send, or sends cut short, ends in an error rather than as a finished file', async () => {
  const failing = browserFileStreamOf({
    open: (listener) => {
      queueMicrotask(() => {
        listener.onMessage(Buffer.from('part').toString('base64'))
        listener.onClose('refused: browser is not running')
      })
      return { close: () => {} }
    },
    onDone: () => {},
  })
  const failure = await new Response(failing).arrayBuffer().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(BrowserUnavailable)
  const cut = browserFileStreamOf({ ...hostSending(1000), onDone: () => {}, expectedBytes: 2000 })
  const cutFailure = await new Response(cut).arrayBuffer().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(cutFailure).toBeInstanceOf(BrowserUnavailable)
})

test('a reader that gives up stops the transfer and releases the file once', async () => {
  let closedCount = 0
  let doneCount = 0
  const stream = browserFileStreamOf({
    open: () => ({
      close: () => {
        closedCount += 1
      },
    }),
    onDone: () => {
      doneCount += 1
    },
  })
  await stream.cancel()
  await stream.cancel()
  expect({ closedCount, doneCount }).toEqual({ closedCount: 1, doneCount: 1 })
})

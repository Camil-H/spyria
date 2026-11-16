import { BrowserUnavailable } from '../domain/errors.ts'

type FileListener = { onOpen(): void; onMessage(data: string): unknown; onClose(error?: string): void }
type FileStreamInput = {
  open: (listener: FileListener) => { close(): void }
  onDone: () => void
  expectedBytes?: number
}

const bufferedBytes = 4 * 1024 * 1024

export const browserFileStreamOf = ({ open, onDone, expectedBytes }: FileStreamInput) => {
  let socket: { close(): void } | undefined
  let waitingForRoom: (() => void)[] = []
  let receivedBytes = 0
  let isDone = false
  const resumeAll = () => {
    for (const resume of waitingForRoom) resume()
    waitingForRoom = []
  }
  const finish = () => {
    isDone = true
    resumeAll()
    onDone()
  }
  return new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        socket = open({
          onOpen: () => {},
          onMessage: (data) => {
            if (isDone) return
            const bytes = Buffer.from(data, 'base64')
            receivedBytes += bytes.byteLength
            controller.enqueue(bytes)
            if ((controller.desiredSize ?? 0) > 0) return
            return new Promise<void>((resume) => {
              waitingForRoom.push(resume)
            })
          },
          onClose: (error) => {
            if (isDone) return
            finish()
            const isCut = expectedBytes !== undefined && receivedBytes !== expectedBytes
            if (error || isCut) controller.error(new BrowserUnavailable('The file could not be read from the browser'))
            else controller.close()
          },
        })
      },
      pull: resumeAll,
      cancel: () => {
        if (isDone) return
        finish()
        socket?.close()
      },
    },
    { highWaterMark: bufferedBytes, size: (chunk) => chunk?.byteLength ?? 0 },
  )
}

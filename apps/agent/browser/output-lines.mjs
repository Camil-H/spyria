export const maximumLineBytes = 6 * 1024 * 1024
export const partCharacters = 128 * 1024
const tooLarge = 'The answer is too large to send'

const partsOf = (line, size) => {
  const parts = []
  for (let offset = 0; offset < line.length; offset += size) parts.push(line.slice(offset, offset + size))
  return parts
}

export const createLineSender = ({ write, maximumBytes = maximumLineBytes, partSize = partCharacters }) => {
  const waiting = []
  let parts = []
  let isAwaitingAcknowledgement = false
  const sendNextPart = () => {
    if (parts.length === 0) parts = partsOf(waiting.shift() ?? '', partSize)
    const data = parts.shift()
    if (data === undefined) return
    isAwaitingAcknowledgement = true
    write(JSON.stringify({ type: 'part', data, isLast: parts.length === 0 }))
  }
  return {
    send: (message) => {
      const line = JSON.stringify(message)
      const bytes = Buffer.byteLength(line)
      if (bytes > maximumBytes)
        return write(
          JSON.stringify(
            typeof message.id === 'number' ? { id: message.id, error: tooLarge } : { type: 'notice', text: tooLarge },
          ),
        )
      if (bytes <= partSize) return write(line)
      waiting.push(line)
      if (!isAwaitingAcknowledgement) sendNextPart()
    },
    acknowledgePart: () => {
      isAwaitingAcknowledgement = false
      if (parts.length > 0 || waiting.length > 0) sendNextPart()
    },
  }
}

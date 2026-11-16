export const maximumLineBytes = 4 * 1024 * 1024
const tooLarge = 'The answer is too large to send'

export const createLineWriter =
  ({ write, maximumBytes = maximumLineBytes }) =>
  (message) => {
    const line = JSON.stringify(message)
    if (Buffer.byteLength(line) <= maximumBytes) return write(line)
    write(
      JSON.stringify(
        typeof message.id === 'number' ? { id: message.id, error: tooLarge } : { type: 'notice', text: tooLarge },
      ),
    )
  }

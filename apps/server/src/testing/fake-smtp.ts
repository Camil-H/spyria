export type CapturedMail = { to: string[]; text: string }

const decodedQuotedPrintable = (body: string) =>
  body
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

export const startFakeSmtp = (port = 0, { dropsAfterMessage = false, greetingDelayMilliseconds = 0 } = {}) => {
  const mails: CapturedMail[] = []
  const replyTo = (line: string, isLastDataLine: boolean) => {
    if (isLastDataLine) return '250 queued'
    const command = line.slice(0, 4).toUpperCase()
    if (command === 'DATA') return '354 end with .'
    if (command === 'QUIT') return '221 bye'
    return '250 ok'
  }
  const server = Bun.listen<{ buffer: string; to: string[]; data: string[] | null }>({
    hostname: '127.0.0.1',
    port,
    socket: {
      open: (socket) => {
        socket.data = { buffer: '', to: [], data: null }
        setTimeout(() => socket.write('220 fake-smtp\r\n'), greetingDelayMilliseconds)
      },
      data: (socket, chunk) => {
        const session = socket.data
        session.buffer += chunk.toString()
        for (let end = session.buffer.indexOf('\r\n'); end >= 0; end = session.buffer.indexOf('\r\n')) {
          const line = session.buffer.slice(0, end)
          session.buffer = session.buffer.slice(end + 2)
          if (session.data && line !== '.') {
            session.data.push(line.startsWith('..') ? line.slice(1) : line)
            continue
          }
          const isLastDataLine = session.data !== null
          if (isLastDataLine) {
            const message = (session.data ?? []).join('\r\n')
            mails.push({ to: session.to, text: decodedQuotedPrintable(message.slice(message.indexOf('\r\n\r\n') + 4)) })
            session.data = null
            session.to = []
            if (dropsAfterMessage) return void socket.end()
          }
          if (/^RCPT TO:/i.test(line)) session.to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, '$1').toLowerCase())
          if (/^DATA$/i.test(line)) session.data = []
          socket.write(`${replyTo(line, isLastDataLine)}\r\n`)
          if (/^QUIT$/i.test(line)) socket.end()
        }
      },
    },
  })
  return { url: `smtp://127.0.0.1:${server.port}`, mails, stop: () => server.stop(true) }
}

export const verificationLinkIn = (mail: CapturedMail | undefined) => mail?.text.match(/https?:\/\/\S+/)?.[0] ?? ''

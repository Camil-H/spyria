type RequestMessage = { role?: string; name?: string; content?: unknown }

export const clearedOutput = '[Earlier output cleared to save context. Run the tool again if you need it.]'
const shortOutputCharacters = 1_000

export const condensationLimitsOf = (scale: number) => ({
  maskingTokens: 100_000 * scale,
  keptOutputs: Math.max(1, Math.round(10 * scale)),
  outputBatch: Math.max(1, Math.round(20 * scale)),
  condenserEvents: Math.max(8, Math.round(400 * scale)),
})

const isMaskable = ({ name, content }: RequestMessage) =>
  name !== 'task_tracker' && !name?.endsWith('delegate') && JSON.stringify(content).length >= shortOutputCharacters

const requestOf = (body: string) => {
  try {
    return JSON.parse(body) as { messages?: RequestMessage[] }
  } catch {
    return undefined
  }
}

export const maskedBody = (body: string, scale = 1) => {
  const { maskingTokens, keptOutputs, outputBatch } = condensationLimitsOf(scale)
  const request = body.length / 4 > maskingTokens ? requestOf(body) : undefined
  const outputs = request?.messages?.filter((message) => message.role === 'tool') ?? []
  const cutoff = Math.floor((outputs.length - keptOutputs) / outputBatch) * outputBatch
  const masked = new Set(outputs.slice(0, Math.max(cutoff, 0)).filter(isMaskable))
  if (masked.size === 0) return body
  return JSON.stringify({
    ...request,
    messages: request?.messages?.map((message) =>
      masked.has(message) ? { ...message, content: clearedOutput } : message,
    ),
  })
}

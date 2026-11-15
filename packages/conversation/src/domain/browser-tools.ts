type Refusal = { refusal: string }
export type BrowserCommand = Readonly<{ command: string; [field: string]: unknown }>
export type BrowserAnswer = Readonly<{ text: string; image?: string }>

const maximumTextLength = 10_000
const maximumExpressionLength = 20_000
const maximumWaitSeconds = 30
const refPattern = /^[a-z0-9]{1,16}$/i
const keyPattern = /^[\w+\-.,;:'"/\\[\]=` ]{1,40}$/
const directions = ['back', 'forward', 'reload'] as const

const refProperty = { type: 'string', description: 'The ref of the element in the latest browser_snapshot, such as e5' }
const toolOf = (
  name: string,
  description: string,
  properties: Record<string, object> = {},
  required: string[] = [],
) => ({
  name,
  description,
  inputSchema: { type: 'object', required, properties },
})

export const browserSnapshotTool = toolOf(
  'browser_snapshot',
  "Read the page open in the browser of the member who prompted you, as an accessibility tree giving each element a ref, such as e5, to act on. Take a new snapshot after the page changes: refs only hold for the latest one. The browser has the member's own sign-ins.",
)
export const browserClickTool = toolOf(
  'browser_click',
  "Click an element of the member's browser by its ref.",
  { ref: refProperty, double: { type: 'boolean', description: 'A double click' } },
  ['ref'],
)
export const browserTypeTool = toolOf(
  'browser_type',
  'Type text key by key into an element, as a person would, for fields that react to each key.',
  {
    ref: refProperty,
    text: { type: 'string' },
    submit: { type: 'boolean', description: 'Press Enter after typing' },
  },
  ['ref', 'text'],
)
export const browserFillTool = toolOf(
  'browser_fill',
  'Replace the value of a field at once.',
  { ref: refProperty, value: { type: 'string' } },
  ['ref', 'value'],
)
export const browserPressTool = toolOf(
  'browser_press',
  'Press a key or a combination, such as Enter, Escape, ArrowDown or Control+A, on an element or on the page.',
  { key: { type: 'string' }, ref: refProperty },
  ['key'],
)
export const browserRunJavaScriptTool = toolOf(
  'browser_run_javascript',
  "Run a JavaScript expression in the page, such as document.title, or an async function called at once, (async () => { … })(), and read its result as JSON. It runs with the member's sign-ins: use it to read, and act through clicks and fields instead when you can.",
  { expression: { type: 'string' } },
  ['expression'],
)
export const browserWaitTool = toolOf(
  'browser_wait',
  'Wait until a text shows on the page, or for a number of seconds, at most 30.',
  { text: { type: 'string' }, seconds: { type: 'number' } },
)
export const browserNavigateTool = toolOf('browser_navigate', 'Go back, go forward or reload the page.', {
  direction: { type: 'string', enum: directions },
})
export const browserScreenshotTool = toolOf('browser_screenshot', "See the page in the member's browser as an image.", {
  fullPage: { type: 'boolean', description: 'The whole page rather than what shows on screen' },
})

export const browserTools = [
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserFillTool,
  browserPressTool,
  browserRunJavaScriptTool,
  browserWaitTool,
  browserNavigateTool,
  browserScreenshotTool,
]
export const isBrowserTool = (name: string) => browserTools.some((tool) => tool.name === name)

const textOf = (value: unknown, maximumLength: number) =>
  typeof value === 'string' && value.length <= maximumLength ? value : undefined
const refOf = (value: unknown) => (typeof value === 'string' && refPattern.test(value) ? value : undefined)
const keyOf = (value: unknown) => (typeof value === 'string' && keyPattern.test(value) ? value : undefined)
const noRef = { refusal: 'Give the ref of an element from the latest browser_snapshot, such as e5' }

const commandParsers: Record<string, (input: Record<string, unknown>) => BrowserCommand | Refusal> = {
  [browserSnapshotTool.name]: () => ({ command: 'snapshot' }),
  [browserClickTool.name]: ({ ref, double }) =>
    refOf(ref) ? { command: 'click', ref, double: double === true } : noRef,
  [browserTypeTool.name]: ({ ref, text, submit }) => {
    if (!refOf(ref)) return noRef
    const typed = textOf(text, maximumTextLength)
    if (typed === undefined) return { refusal: `Give the text to type, at most ${maximumTextLength} characters` }
    return { command: 'type', ref, text: typed, submit: submit === true }
  },
  [browserFillTool.name]: ({ ref, value }) => {
    if (!refOf(ref)) return noRef
    const filled = textOf(value, maximumTextLength)
    if (filled === undefined) return { refusal: `Give the value to fill, at most ${maximumTextLength} characters` }
    return { command: 'fill', ref, value: filled }
  },
  [browserPressTool.name]: ({ key, ref }) => {
    if (!keyOf(key)) return { refusal: 'Give a key such as Enter, Escape, ArrowDown or Control+A' }
    if (ref !== undefined && !refOf(ref)) return noRef
    return { command: 'press', key, ...(ref !== undefined && { ref }) }
  },
  [browserRunJavaScriptTool.name]: ({ expression }) => {
    const script = textOf(expression, maximumExpressionLength)
    return script?.trim()
      ? { command: 'evaluate', expression: script }
      : { refusal: `Give a JavaScript expression, at most ${maximumExpressionLength} characters` }
  },
  [browserWaitTool.name]: ({ text, seconds }) => {
    const waited = text === undefined ? undefined : textOf(text, 500)
    if (text !== undefined && !waited) return { refusal: 'Give the text to wait for, at most 500 characters' }
    const isSeconds = seconds === undefined || (typeof seconds === 'number' && seconds >= 0)
    if (!isSeconds) return { refusal: 'Give the seconds to wait as a number' }
    if (!waited && seconds === undefined) return { refusal: 'Give a text to wait for or a number of seconds' }
    return {
      command: 'wait',
      ...(waited && { text: waited }),
      ...(seconds !== undefined && { seconds: Math.min(maximumWaitSeconds, seconds as number) }),
    }
  },
  [browserNavigateTool.name]: ({ direction }) =>
    directions.includes(direction as (typeof directions)[number])
      ? { command: 'navigate', direction }
      : { refusal: 'Give the direction: back, forward or reload' },
  [browserScreenshotTool.name]: ({ fullPage }) => ({ command: 'screenshot', fullPage: fullPage === true }),
}

export const browserCommandOf = (name: string, input: unknown): { browserCommand: BrowserCommand } | Refusal => {
  const parse = commandParsers[name]
  if (!parse) return { refusal: 'Unknown tool' }
  const parsed = parse(typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {})
  return typeof parsed.refusal === 'string' ? { refusal: parsed.refusal } : { browserCommand: parsed as BrowserCommand }
}

export const openCommandOf = (url: string): BrowserCommand => ({ command: 'open', url })

export const submitCheckOf = (command: BrowserCommand): BrowserCommand | 'always' | 'never' => {
  if (command.command === 'evaluate') return 'always'
  if (command.command === 'type') return command.submit === true ? 'always' : 'never'
  if (command.command === 'click') return { command: 'would_submit', action: 'click', ref: command.ref }
  if (command.command === 'press' && command.ref !== undefined)
    return { command: 'would_submit', action: 'press', ref: command.ref, key: command.key }
  if (command.command === 'press') return command.key === 'Enter' ? 'always' : 'never'
  return 'never'
}

export const browserAnswerOf = (result: unknown): BrowserAnswer => {
  if (typeof result === 'string') return { text: result }
  const { text, image } = (result ?? {}) as { text?: unknown; image?: unknown }
  return { text: typeof text === 'string' ? text : '', ...(typeof image === 'string' && { image }) }
}

export const visitedAddressOf = (url: string) => {
  if (!URL.canParse(url)) return undefined
  const { protocol, origin, pathname } = new URL(url)
  return protocol === 'http:' || protocol === 'https:' ? `${origin}${pathname}` : undefined
}

export const browserTurnedOffForAgents = 'The browser is turned off for agents in this workspace'
export const browserAsleepRefusal =
  "The chat's runtime is asleep, so the member's browser cannot start: wait for the next message to wake it"

const maximumUploadBytes = 25 * 1024 * 1024
const maximumUploadFiles = 10
const inputKinds = ['mouse', 'key', 'text']
const mouseActions = ['move', 'down', 'up', 'wheel']
const keyActions = ['down', 'up']
const mouseButtons = ['left', 'middle', 'right']
const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const modifierFlagsOf = (event: Record<string, unknown>) => ({
  alt: event.alt === true,
  control: event.control === true,
  meta: event.meta === true,
  shift: event.shift === true,
})

const inputEventOf = (event: Record<string, unknown>) => {
  if (!inputKinds.includes(String(event.kind))) return undefined
  if (event.kind === 'mouse') {
    if (!mouseActions.includes(String(event.action))) return undefined
    return {
      kind: 'mouse',
      action: event.action,
      x: numberOf(event.x),
      y: numberOf(event.y),
      button: mouseButtons.includes(String(event.button)) ? event.button : 'left',
      clickCount: numberOf(event.clickCount),
      deltaX: numberOf(event.deltaX),
      deltaY: numberOf(event.deltaY),
      ...modifierFlagsOf(event),
    }
  }
  if (event.kind === 'key') {
    const key = typeof event.key === 'string' && event.key.length <= 32 ? event.key : undefined
    return key && keyActions.includes(String(event.action)) ? { kind: 'key', action: event.action, key } : undefined
  }
  const text = textOf(event.text, maximumTextLength)
  return text ? { kind: 'text', text } : undefined
}

const uploadsOf = (files: unknown) => {
  if (!Array.isArray(files) || files.length === 0 || files.length > maximumUploadFiles) return undefined
  const uploads = files.map((file) => {
    const { name, mimeType, data } = (file ?? {}) as Record<string, unknown>
    return {
      name: textOf(name, 255),
      mimeType: textOf(mimeType, 255) ?? '',
      data: textOf(data, maximumUploadBytes * 2),
    }
  })
  return uploads.every(({ name, data }) => name && data !== undefined) ? uploads : undefined
}

const webAddress = /^https?:\/\//i

export const memberMessageOf = (received: unknown): { type: string; [field: string]: unknown } | undefined => {
  const message = (typeof received === 'object' && received !== null ? received : {}) as Record<string, unknown>
  if (message.type === 'frame_ack') return { type: 'frame_ack' }
  if (message.type === 'resize')
    return { type: 'resize', width: numberOf(message.width), height: numberOf(message.height) }
  if (message.type === 'go')
    return directions.includes(message.direction as (typeof directions)[number])
      ? { type: 'go', direction: message.direction }
      : undefined
  if (message.type === 'go_to') {
    const url = textOf(message.url, 2048)
    return url && webAddress.test(url) && URL.canParse(url) ? { type: 'go_to', url } : undefined
  }
  if (message.type === 'input') {
    const event = inputEventOf((message.event ?? {}) as Record<string, unknown>)
    return event && { type: 'input', event }
  }
  if (message.type === 'files') {
    const files = uploadsOf(message.files)
    return files && { type: 'files', files }
  }
  return undefined
}

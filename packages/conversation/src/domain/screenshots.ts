type Refusal = { refusal: string }
export type ScreenshotRequest = Readonly<{
  url: string
  name: string
  viewport: (typeof viewports)[number]
  fullPage: boolean
  theme: (typeof themes)[number]
}>

const viewports = ['desktop', 'mobile'] as const
const themes = ['light', 'dark'] as const
const maximumAddressLength = 2048
const maximumNameLength = 64
const webAddress = /^https?:\/\//i
const namePattern = new RegExp(`^[\\w-]{1,${maximumNameLength}}$`)

export const takeScreenshotTool = {
  name: 'take_screenshot',
  description:
    'Take a screenshot of a web page from inside the runtime, typically the app you run here (http://localhost:<port>) or a public page, saved as .spyria/screenshots/<name>.png. Show it to the members in your reply with ![what it shows](.spyria/screenshots/<name>.png). Screenshots belong in the conversation, not in commits or pull requests.',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The http or https address of the page' },
      name: {
        type: 'string',
        description: 'The file name without .png: letters, digits, - and _. Taken from the address when left out.',
      },
      viewport: { type: 'string', enum: viewports, description: 'desktop (1280×800, the default) or mobile (390×844)' },
      fullPage: {
        type: 'boolean',
        description: 'The whole page, up to 10,000 pixels tall, rather than its first screen',
      },
      theme: { type: 'string', enum: themes, description: 'The color scheme the page is shown in, light by default' },
    },
  },
}

const nameFromAddressOf = (url: string) => {
  const { host, pathname } = new URL(url)
  const words = `${host}${pathname}`.match(/[a-z0-9_]+/gi) ?? []
  return words.join('-').slice(0, maximumNameLength).replace(/-$/, '') || 'screenshot'
}

const choiceOf = <Choice extends string>(value: unknown, choices: readonly Choice[]) =>
  value === undefined ? choices[0] : choices.find((choice) => choice === value)

export const screenshotRequestOf = (input: unknown): ScreenshotRequest | Refusal => {
  const { url, name, viewport, fullPage = false, theme } = (input ?? {}) as Record<string, unknown>
  const address = typeof url === 'string' ? url.trim() : ''
  if (!webAddress.test(address) || !URL.canParse(address) || address.length > maximumAddressLength)
    return { refusal: 'Give the http or https address of the page to take a screenshot of' }
  if (name !== undefined && (typeof name !== 'string' || !namePattern.test(name)))
    return { refusal: `A screenshot's name has only letters, digits, - and _, up to ${maximumNameLength} characters` }
  const chosenViewport = choiceOf(viewport, viewports)
  if (!chosenViewport) return { refusal: 'The viewport is desktop or mobile' }
  const chosenTheme = choiceOf(theme, themes)
  if (!chosenTheme) return { refusal: 'The theme is light or dark' }
  if (typeof fullPage !== 'boolean') return { refusal: 'fullPage is true or false' }
  return {
    url: address,
    name: name ?? nameFromAddressOf(address),
    viewport: chosenViewport,
    fullPage,
    theme: chosenTheme,
  }
}

export const screenshotTakenText = (path: string, url: string) =>
  `Saved ${path}. Show it to the members with ![Screenshot of ${url}](${path})`

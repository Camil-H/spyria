import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationCommands } from './commands.ts'
import Markdown from './Markdown.tsx'
import { ChatMediaContext, ConversationProvider, LoadedRemoteImagesContext } from './providers.tsx'

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

test('raw HTML from the model is shown as text, never as elements', () => {
  const html = render('<script>window.ran = true</script>\n\nHello <img src="x" onerror="window.ran = true"> there')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;script&gt;window.ran = true&lt;/script&gt;')
  expect(html).toContain('&lt;img src=&quot;x&quot; onerror=&quot;window.ran = true&quot;&gt;')
})

test('a remote image is a placeholder naming its domain', () => {
  const html = render('![Chart](https://images.example.com/chart.png)')
  expect(html).not.toContain('<img')
  expect(html).toContain('Load image from images.example.com')
  expect(render('![Chart](chart.png)')).toContain('Load image from this message')
})

test('links open in a new tab without opener or referrer and show their domain', () => {
  const html = render('[Pricing](https://docs.example.com/pricing) and [bad](javascript:alert(1))')
  expect(html).toContain('href="https://docs.example.com/pricing"')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).toContain('>(docs.example.com)</span>')
  expect(render('[Notes](notes.md)')).toContain('>()</span>')
  expect(html).not.toContain('javascript:')
})

test('GitHub tables, task lists and fenced code with a copy button are rendered', () => {
  const html = render('| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n```ts\nconst a = 1\n```')
  expect(html).toContain('<table')
  expect(html).toContain('type="checkbox"')
  expect(html).toContain('Copy code')
  expect(html).toContain('const a = 1')
})

test('double underscores underline, double stars stay bold', () => {
  const html = render('__under__ and **bold** and a_snake_case_name')
  expect(html).toContain('<u>under</u>')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('a_snake_case_name')
})

test('a mention of a workspace member is bold, outside code and links, and on a line kept apart', () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={'__Hi__ @Alice Martin, see @bob\n`@Bob` [@Bob](https://example.com) mail@bob.dev'}
      keepsLineBreaks
      mentionNames={['Alice Martin', 'Bob']}
    />,
  )
  expect(html).toContain('<u>Hi</u> <strong>@Alice Martin</strong>, see <strong>@bob</strong><br/>')
  expect(html).toContain('<code>@Bob</code>')
  expect(html).toContain('>@Bob <span')
  expect(html).toContain('mail@bob.dev')
  expect(html.match(/<strong>/g)).toHaveLength(2)
})

test('in a runtime chat, an image path is a file of the runtime, loaded through the server; a URL still waits for a click', () => {
  const commands = { readMedia: async () => new Blob() } as unknown as ConversationCommands
  const html = renderToStaticMarkup(
    <ConversationProvider commands={commands} agentStream={{ subscribe: () => () => undefined }}>
      <ChatMediaContext value={{ chatId: 'chat-1', isRuntime: true }}>
        <Markdown text={'![Sales chart](out/sales%20chart.png)\n\n![Logo](https://images.example.com/logo.png)'} />
      </ChatMediaContext>
    </ConversationProvider>,
  )
  expect(html).toContain('aria-label="Loading Sales chart"')
  expect(html).toContain('Load image from images.example.com')
  expect(html).not.toContain('<img')
})

test('a line break stays a line break when asked, as in member messages; standard Markdown joins the lines', () => {
  const text = 'Alice (member, human) · 09:05 UTC\nCan we ship it?\n\n- one\n- two\n\n```\na\nb\n```'
  const kept = renderToStaticMarkup(<Markdown text={text} keepsLineBreaks />)
  expect(kept).toContain('Alice (member, human) · 09:05 UTC<br/>\nCan we ship it?')
  expect(kept).toContain('<li>one</li>')
  expect(kept).toContain('a\nb')
  expect(render(text)).toContain('Alice (member, human) · 09:05 UTC\nCan we ship it?')
  expect(render(text)).not.toContain('<br/>')
})

test('in a runtime chat, only the first four images load on their own; later ones wait for a click', () => {
  const commands = { readMedia: async () => new Blob() } as unknown as ConversationCommands
  const html = renderToStaticMarkup(
    <ConversationProvider commands={commands} agentStream={{ subscribe: () => () => undefined }}>
      <ChatMediaContext value={{ chatId: 'chat-1', isRuntime: true }}>
        <Markdown
          text={Array.from({ length: 6 }, (_, index) => `![Chart ${index + 1}](chart-${index + 1}.png)`).join('\n\n')}
        />
      </ChatMediaContext>
    </ConversationProvider>,
  )
  expect(html.match(/aria-label="Loading Chart \d"/g)).toHaveLength(4)
  expect(html).toContain('Chart 5')
  expect(html).not.toContain('Loading Chart 5')
  expect(html).not.toContain('Loading Chart 6')
})

test('a remote image the viewer loaded in this chat shows at once, so a stored reply keeps the click made on its earlier copy', () => {
  const html = renderToStaticMarkup(
    <LoadedRemoteImagesContext value={{ sources: new Set(['https://images.example.com/chart.png']), load: () => {} }}>
      <Markdown
        text={'![Chart](https://images.example.com/chart.png)\n\n![Logo](https://images.example.com/logo.png)'}
      />
    </LoadedRemoteImagesContext>,
  )
  expect(html).toContain('<img src="https://images.example.com/chart.png" alt="Chart"')
  expect(html).not.toContain('logo.png')
  expect(html).toContain('Load image from images.example.com')
})

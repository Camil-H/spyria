import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationCommands } from './commands.ts'
import Markdown, { StreamedMarkdown } from './Markdown.tsx'
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

test('a streamed answer renders as Markdown while it grows, an open code block already shown as code', () => {
  const html = renderToStaticMarkup(<StreamedMarkdown text={'# Plan\n\n- **Read** the file\n\n```ts\nconst a = 1'} />)
  expect(html).toContain('<h1>Plan</h1>')
  expect(html).toContain('<strong>Read</strong>')
  expect(html).toContain('const a = 1')
  expect(html).toContain('Copy code')
  expect(renderToStaticMarkup(<StreamedMarkdown text="<b>raw</b>" />)).toContain('&lt;b&gt;raw&lt;/b&gt;')
})

test('a streamed answer loads its first four runtime images on their own across its blocks, as the stored answer does', () => {
  const commands = { readMedia: async () => new Blob() } as unknown as ConversationCommands
  const text = Array.from(
    { length: 6 },
    (_, index) => `Shot ${index + 1}:\n\n![Shot ${index + 1}](out/${index + 1}.png)`,
  )
  const html = renderToStaticMarkup(
    <ConversationProvider commands={commands} agentStream={{ subscribe: () => () => undefined }}>
      <ChatMediaContext value={{ chatId: 'chat-1', isRuntime: true }}>
        <StreamedMarkdown text={text.join('\n\n')} />
      </ChatMediaContext>
    </ConversationProvider>,
  )
  expect([...html.matchAll(/aria-label="Loading Shot \d"/g)].map(([label]) => label)).toEqual(
    [1, 2, 3, 4].map((shot) => `aria-label="Loading Shot ${shot}"`),
  )
})

const renderInRuntimeChat = (markdown: ReactElement) => {
  const commands = { readMedia: async () => new Blob() } as unknown as ConversationCommands
  return renderToStaticMarkup(
    <ConversationProvider commands={commands} agentStream={{ subscribe: () => () => undefined }}>
      <ChatMediaContext value={{ chatId: 'chat-1', isRuntime: true }}>{markdown}</ChatMediaContext>
    </ConversationProvider>,
  )
}
const autoLoadedShotsOf = (html: string) =>
  [...html.matchAll(/aria-label="Loading (Shot \d)"/g)].map(([, shot]) => shot)

test('a streamed answer links a reference whose definition comes in a later block, as the stored answer does', () => {
  const text = 'See [the pricing][pricing] first.\n\nThen decide.\n\n[pricing]: https://docs.example.com/pricing'
  const html = renderToStaticMarkup(<StreamedMarkdown text={text} />)
  expect(html).toContain('href="https://docs.example.com/pricing"')
  expect(html).not.toContain('[the pricing]')
  expect(html).not.toContain('[pricing]:')
  expect(html.match(/<a /g)).toHaveLength(render(text).match(/<a /g)?.length ?? 0)
})

test('a streamed answer counts only the images it shows: not image syntax in code or escaped, nor a reference never defined', () => {
  const text = [
    'Write `![alt](path.png)` for an image, or \\![this] to keep it as text.',
    '```md\n![Not shown](out/0.png)\n```',
    '![Missing][nowhere]',
    ...[1, 2, 3, 4, 5].map((shot) => `![Shot ${shot}](out/${shot}.png)`),
  ].join('\n\n')
  expect(autoLoadedShotsOf(renderInRuntimeChat(<StreamedMarkdown text={text} />))).toEqual([
    'Shot 1',
    'Shot 2',
    'Shot 3',
    'Shot 4',
  ])
  expect(autoLoadedShotsOf(renderInRuntimeChat(<Markdown text={text} />))).toEqual([
    'Shot 1',
    'Shot 2',
    'Shot 3',
    'Shot 4',
  ])
})

test('a streamed answer counts images by reference across its blocks, with their definitions at the end', () => {
  const text = [
    ...[1, 2, 3].map((shot) => `Shot ${shot}:\n\n![Shot ${shot}][shot-${shot}]`),
    '![Shot 4](out/4.png) and ![Shot 5][shot-5]',
    ...[1, 2, 3, 5].map((shot) => `[shot-${shot}]: out/${shot}.png`),
  ].join('\n\n')
  const streamed = autoLoadedShotsOf(renderInRuntimeChat(<StreamedMarkdown text={text} />))
  expect(streamed).toEqual(['Shot 1', 'Shot 2', 'Shot 3', 'Shot 4'])
  expect(streamed).toEqual(autoLoadedShotsOf(renderInRuntimeChat(<Markdown text={text} />)))
})

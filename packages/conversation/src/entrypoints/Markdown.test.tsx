import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from './Markdown.tsx'

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

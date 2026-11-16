import { expect, test } from 'bun:test'
import type { Element } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { renderToStaticMarkup } from 'react-dom/server'
import { copiedSelectionOf } from './copied-markdown.ts'
import Markdown from './Markdown.tsx'

const copiedHtmlOf = (html: string) => copiedSelectionOf(fromHtml(html, { fragment: true }).children[0] as Element)
const copiedOf = (text: string, keepsLineBreaks = false) =>
  copiedHtmlOf(renderToStaticMarkup(<Markdown text={text} keepsLineBreaks={keepsLineBreaks} />))

test('a copied message keeps its formatting as Markdown', () => {
  const text = [
    '## Plan',
    '**Bold**, *italic*, ~~gone~~ and `code`.',
    '- first\n  - nested\n- second',
    '1. one\n2. two',
    '> quoted',
    '| Name | Count |\n| --- | --- |\n| a | 1 |',
  ].join('\n\n')
  expect(copiedOf(text).markdown).toBe(
    [
      '## Plan',
      '**Bold**, *italic*, ~~gone~~ and `code`.',
      '- first\n  - nested\n- second',
      '1. one\n2. two',
      '> quoted',
      '| Name | Count |\n| ---- | ----- |\n| a    | 1     |',
    ].join('\n\n'),
  )
})

test('a copied link keeps its address without the domain shown beside it', () => {
  const { markdown, html } = copiedOf('See [Pricing](https://docs.example.com/pricing).')
  expect(markdown).toBe('See [Pricing](https://docs.example.com/pricing).')
  expect(html).not.toContain('docs.example.com)')
})

test('a copied code block keeps its language and leaves out the copy button', () => {
  const { markdown, html } = copiedOf('```ts\nconst answer = 42\n```')
  expect(markdown).toBe('```ts\nconst answer = 42\n```')
  expect(html).not.toContain('<button')
})

test("a member's line breaks stay plain new lines", () => {
  expect(copiedOf('first line\nsecond line', true).markdown).toBe('first line\nsecond line')
})

test('copied underlined text stays underlined', () => {
  expect(copiedOf('__under__ text').markdown).toBe('__under__ text')
})

test('a block the selection only touches at its start is left out', () => {
  expect(
    copiedHtmlOf(
      '<div><p>para</p><ol start="3"><li></li></ol><blockquote><p></p></blockquote><table><thead><tr><th></th></tr></thead></table></div>',
    ).markdown,
  ).toBe('para')
})

test('a copied table keeps its empty cells in place', () => {
  expect(copiedOf('| Name | Count |\n| --- | --- |\n| a |  |').markdown).toBe(
    '| Name | Count |\n| ---- | ----- |\n| a    |       |',
  )
})

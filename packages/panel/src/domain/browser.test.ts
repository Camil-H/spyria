import { expect, test } from 'bun:test'
import { browsedPageOf, isHtmlFile, isWebAddress } from './browser.ts'

test('a typed address opens as it is, a host opens over https, a local host over http', () => {
  expect(browsedPageOf(' https://example.com/docs?x=1 ')).toEqual({
    url: 'https://example.com/docs?x=1',
    title: 'https://example.com/docs?x=1',
  })
  expect(browsedPageOf('example.com/pricing')).toEqual({
    url: 'https://example.com/pricing',
    title: 'example.com/pricing',
  })
  expect(browsedPageOf('docs.example.co.uk')?.url).toBe('https://docs.example.co.uk')
  expect(browsedPageOf('localhost:3000/invoices')?.url).toBe('http://localhost:3000/invoices')
  expect(browsedPageOf('127.0.0.1:8080')?.url).toBe('http://127.0.0.1:8080')
})

test('anything else is searched for, and blank text opens nothing', () => {
  expect(browsedPageOf('zero sync docs')).toEqual({
    url: 'https://www.bing.com/search?q=zero%20sync%20docs',
    title: 'zero sync docs',
  })
  expect(browsedPageOf('javascript:alert(1)')?.url).toBe('https://www.bing.com/search?q=javascript%3Aalert(1)')
  expect(browsedPageOf('react')?.url).toBe('https://www.bing.com/search?q=react')
  expect(browsedPageOf('   ')).toBeUndefined()
})

test('web addresses are told apart from workspace files, and HTML files from other files', () => {
  expect(isWebAddress('https://example.com')).toBe(true)
  expect(isWebAddress('reports/totals.html')).toBe(false)
  expect(isHtmlFile('reports/totals.html')).toBe(true)
  expect(isHtmlFile('chart.SVG')).toBe(true)
  expect(isHtmlFile('notes.md')).toBe(false)
})

import { expect, test } from 'bun:test'
import { browsedPageOf, followedPageOf, framedHtmlOf, isHtmlFile, isOnMembersMachine, isWebAddress } from './browser.ts'

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

test('a page on the member’s own machine is told apart from one on the web', () => {
  expect(isOnMembersMachine('http://localhost:3000/invoices')).toBe(true)
  expect(isOnMembersMachine('http://127.0.0.1:8080')).toBe(true)
  expect(isOnMembersMachine('https://localhost.example.com')).toBe(false)
  expect(isOnMembersMachine('https://example.com/?next=localhost')).toBe(false)
})

test('a link followed in a page opens its web address, and a Bing result opens the result itself', () => {
  expect(followedPageOf('https://example.com/docs#setup')).toEqual({
    url: 'https://example.com/docs#setup',
    title: 'https://example.com/docs#setup',
  })
  const result = `https://www.bing.com/ck/a?!&&p=abc&u=a1${btoa('https://www.typescriptlang.org/docs/').replaceAll('=', '')}&ntb=1`
  expect(followedPageOf(result)?.url).toBe('https://www.typescriptlang.org/docs/')
  expect(followedPageOf('https://www.bing.com/ck/a?u=a1!!!')?.url).toBe('https://www.bing.com/ck/a?u=a1!!!')
  expect(followedPageOf(`https://www.bing.com/ck/a?u=a1${btoa('javascript:alert(1)')}`)?.url).toStartWith(
    'https://www.bing.com/ck/a',
  )
  for (const address of ['javascript:alert(1)', 'mailto:a@example.com', 'not an address', 42]) {
    expect(followedPageOf(address)).toBeUndefined()
  }
})

test('a page is framed with its address as the base of its links, keeping its doctype and its own base', () => {
  expect(
    framedHtmlOf({
      url: 'https://example.com/docs/',
      html: '<!DOCTYPE html><html><head lang="en"><title>Docs</title>',
    }),
  ).toBe('<!DOCTYPE html><html><head lang="en"><base href="https://example.com/docs/"><title>Docs</title>')
  expect(framedHtmlOf({ url: 'https://example.com/a?b=1&c="2"', html: '<!doctype html><p>Hi' })).toBe(
    '<!doctype html><base href="https://example.com/a?b=1&amp;c=%222%22"><p>Hi',
  )
  expect(framedHtmlOf({ url: 'https://example.com/blog/post', html: '<head><base href="/static/">' })).toBe(
    '<head><base href="https://example.com/static/"><base href="/static/">',
  )
  expect(framedHtmlOf({ url: 'https://example.com/', html: '<header>Top</header>' })).toBe(
    '<base href="https://example.com/"><header>Top</header>',
  )
})

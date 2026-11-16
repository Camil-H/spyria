import { expect, test } from 'bun:test'
import {
  browsedPageOf,
  isHtmlFile,
  isWebAddress,
  mouseButtonOf,
  pageKeyOf,
  pagePointOf,
  stateTextOf,
} from './browser.ts'

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

test('a point on the shown stream maps to the same point of the page, whatever size the stream is shown at', () => {
  expect(pagePointOf({ x: 200, y: 150 }, { width: 400, height: 300 }, { width: 800, height: 600 })).toEqual({
    x: 400,
    y: 300,
  })
  expect(pagePointOf({ x: 10, y: 10 }, { width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 })
})

test("mouse buttons keep their names, and on a Mac the command key acts as the page's control key", () => {
  expect([0, 1, 2, 3].map(mouseButtonOf)).toEqual(['left', 'middle', 'right', 'left'])
  expect(pageKeyOf('Meta', true)).toBe('Control')
  expect(pageKeyOf('Meta', false)).toBe('Meta')
  expect(pageKeyOf('a', true)).toBe('a')
})

test("the browser's state reads in the member's terms", () => {
  expect(stateTextOf({ state: 'starting' })).toBe('Starting your browser…')
  expect(stateTextOf({ state: 'running', canBrowse: true })).toBeUndefined()
  expect(stateTextOf({ state: 'stopped', reason: 'idle' })).toBe('Your browser stopped after 10 minutes without use')
  expect(stateTextOf({ state: 'unavailable', reason: 'no room for another browser on this host' })).toBe(
    'no room for another browser on this host',
  )
})

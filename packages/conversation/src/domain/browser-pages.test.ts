import { expect, test } from 'bun:test'
import { openedPageOf } from './browser-pages.ts'

const refusalOf = (address: unknown) => (openedPageOf({ address }) as { refusal?: string }).refusal

test('an open_page call opens a web address or a workspace file, titled by the agent or by its address', () => {
  expect(openedPageOf({ address: 'https://example.com/docs', title: ' Docs ' })).toEqual({
    url: 'https://example.com/docs',
    title: 'Docs',
  })
  expect(openedPageOf({ address: 'http://example.com' })).toEqual({
    url: 'http://example.com',
    title: 'http://example.com',
  })
  expect(openedPageOf({ address: '/workspace/project/reports/totals.html', title: 'Totals' })).toEqual({
    url: 'reports/totals.html',
    title: 'Totals',
  })
  expect(openedPageOf({ address: './index.html' })).toEqual({ url: 'index.html', title: 'index.html' })
  expect(openedPageOf({ address: 'https://example.com', title: 'x'.repeat(300) })).toMatchObject({
    title: 'x'.repeat(200),
  })
})

test('an address with another scheme, outside the workspace, blank or too long is refused with its reason', () => {
  for (const address of [
    'javascript:alert(1)',
    'data:text/html,<p>',
    'file:///etc/passwd',
    '../secrets.txt',
    'reports/../../x.html',
    '  ',
    'https://',
    `https://example.com/${'a'.repeat(2048)}`,
    42,
  ])
    expect(refusalOf(address)).toBeString()
  expect(refusalOf('javascript:alert(1)')).toBe('Only http and https addresses and project files are opened')
  expect(refusalOf('../secrets.txt')).toBe('A project file is opened by its path inside the project')
  expect(refusalOf('https://')).toBe('https:// is not a valid web address')
  expect(refusalOf(' ')).toBe('Give the address of the page to open')
  expect(refusalOf(`https://example.com/${'a'.repeat(2048)}`)).toBe('The address is longer than 2048 characters')
})

test("a local or internal address opens in the member's browser, where the workspace's network rules decide what it reaches", () => {
  for (const address of [
    'http://localhost:3000/invoices',
    'http://127.0.0.1:8080',
    'http://intranet/wiki',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:3000',
    'http://172.15.0.1',
  ])
    expect(openedPageOf({ address })).toEqual({ url: address, title: address })
})

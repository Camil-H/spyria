import { expect, test } from 'bun:test'
import { isPrivateNetworkAddress, openedPageOf } from './browser-pages.ts'

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

test('an address on the member’s own machine or network is refused, in any spelling', () => {
  for (const address of [
    'http://localhost:3000/invoices',
    'http://LOCALHOST./',
    'http://app.localhost',
    'http://printer.local',
    'http://intranet/wiki',
    'http://127.0.0.1:8080',
    'http://127.1',
    'http://2130706433',
    'http://0x7f.1',
    'http://0.0.0.0:3000',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1',
    'https://user:secret@10.0.0.1:8443/x',
    'http://[::1]:3000',
    'http://[::]',
    'http://[0:0:0:0:0:0:0:1]',
    'http://[fe80::1]',
    'http://[fd12:3456::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:192.168.0.1]',
  ])
    expect(refusalOf(address)).toEndWith("is on the member's own machine or network, so it is not opened")
})

test('a public address next to a private range still opens', () => {
  for (const address of [
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://100.128.0.1',
    'http://169.255.0.1',
    'http://11.0.0.1',
    'http://[2606:4700::1111]',
    'http://[::ffff:8.8.8.8]',
    'https://localhost.example.com',
    'https://local.example.com',
  ])
    expect(openedPageOf({ address })).toEqual({ url: address, title: address })
})

test('a resolved address is private in any IPv6 spelling that carries a private IPv4 address', () => {
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    'fd00::1',
    'fe80::1',
  ])
    expect({ address, isPrivate: isPrivateNetworkAddress(address) }).toEqual({ address, isPrivate: true })
  for (const address of ['8.8.8.8', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::', '2606:4700::1111'])
    expect({ address, isPrivate: isPrivateNetworkAddress(address) }).toEqual({ address, isPrivate: false })
})

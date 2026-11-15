import { expect, test } from 'bun:test'
import {
  browserAddressOf,
  browserSettingsFrom,
  defaultBrowserSettings,
  isBrowserAddress,
  isBrowserSettings,
  maximumBrowserAddresses,
} from './browser-settings.ts'

test('a workspace without browser settings gets the defaults, which block internal networks', () => {
  expect(browserSettingsFrom(null)).toBe(defaultBrowserSettings)
  expect(browserSettingsFrom({ forAgents: false })).toBe(defaultBrowserSettings)
  expect(defaultBrowserSettings.blockInternalNetworks).toBe(true)
  expect(defaultBrowserSettings.approveSubmits).toBe(true)
})

test('stored settings read back as they are', () => {
  const settings = {
    ...defaultBrowserSettings,
    forMembers: false,
    allowedInternalAddresses: ['staging.internal', '10.0.0.5', 'fd00::1'],
    blockedSites: ['example.com'],
    signInHours: 8,
  }
  expect(browserSettingsFrom(settings)).toEqual(settings)
})

test('settings with an invalid value, an unknown field or too many addresses are refused', () => {
  expect(isBrowserSettings({ ...defaultBrowserSettings, signInHours: 0 })).toBe(false)
  expect(isBrowserSettings({ ...defaultBrowserSettings, signInHours: 1.5 })).toBe(false)
  expect(isBrowserSettings({ ...defaultBrowserSettings, downloads: 'yes' })).toBe(false)
  expect(isBrowserSettings({ ...defaultBrowserSettings, allowedSites: ['https://example.com/'] })).toBe(false)
  expect(isBrowserSettings({ ...defaultBrowserSettings, blockedSites: ['a.com', 'a.com'] })).toBe(false)
  expect(isBrowserSettings({ ...defaultBrowserSettings, extra: true })).toBe(false)
  const tooMany = Array.from({ length: maximumBrowserAddresses + 1 }, (_, index) => `site${index}.com`)
  expect(isBrowserSettings({ ...defaultBrowserSettings, allowedSites: tooMany })).toBe(false)
})

test('a typed address reads as its host name, lower case, without scheme, port or path', () => {
  expect(browserAddressOf(' https://Staging.Example.com:8443/path ')).toBe('staging.example.com')
  expect(browserAddressOf('example.com.')).toBe('example.com')
  expect(browserAddressOf('[FD00::1]:80')).toBe('fd00::1')
  expect(isBrowserAddress(browserAddressOf('http://10.0.0.5:3000'))).toBe(true)
  expect(isBrowserAddress('exa mple.com')).toBe(false)
  expect(isBrowserAddress('-bad.com')).toBe(false)
})

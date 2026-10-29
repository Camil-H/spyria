import { expect, test } from 'bun:test'
import { maximumSidebarWidth, minimumSidebarWidth, sidebarWidthOf } from './useSidebarWidth.ts'

test.each([
  ['nothing stored keeps the default width', null, 256],
  ['a stored width within the bounds is kept', '320', 320],
  ['a fractional width is rounded', '300.6', 301],
  ['a width below the minimum is raised to it', '100', minimumSidebarWidth],
  ['a width above the maximum is lowered to it', '2000', maximumSidebarWidth],
  ['an unreadable value keeps the default width', 'wide', 256],
] as const)('%s', (_, storedWidth, width) => {
  expect(sidebarWidthOf(storedWidth)).toBe(width)
})

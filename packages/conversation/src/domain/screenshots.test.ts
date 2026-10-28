import { expect, test } from 'bun:test'
import { screenshotRequestOf } from './screenshots.ts'

test('a screenshot defaults to the first screen of a desktop page in light, named after its address', () => {
  expect(screenshotRequestOf({ url: ' http://localhost:3000/settings/billing?tab=2 ' })).toEqual({
    url: 'http://localhost:3000/settings/billing?tab=2',
    name: 'localhost-3000-settings-billing',
    viewport: 'desktop',
    fullPage: false,
    theme: 'light',
  })
  expect(
    screenshotRequestOf({
      url: 'https://example.com',
      name: 'home_dark',
      viewport: 'mobile',
      fullPage: true,
      theme: 'dark',
    }),
  ).toEqual({
    url: 'https://example.com',
    name: 'home_dark',
    viewport: 'mobile',
    fullPage: true,
    theme: 'dark',
  })
  expect(screenshotRequestOf({ url: `https://example.com/${'long-'.repeat(30)}` })).toMatchObject({
    name: 'example-com-long-long-long-long-long-long-long-long-long-long-lo',
  })
})

test('a screenshot request that is not an http address, or with a name, viewport or theme Spyria does not offer, is refused with its reason', () => {
  const refusalOf = (input: unknown) => (screenshotRequestOf(input) as { refusal?: string }).refusal
  for (const url of [undefined, '', 'file:///etc/passwd', 'javascript:alert(1)', 'localhost:3000', 'https://', 42])
    expect(refusalOf({ url })).toBe('Give the http or https address of the page to take a screenshot of')
  for (const name of ['../escape', 'a b', '', 'x'.repeat(65), 7])
    expect(refusalOf({ url: 'https://example.com', name })).toBe(
      "A screenshot's name has only letters, digits, - and _, up to 64 characters",
    )
  expect(refusalOf({ url: 'https://example.com', viewport: 'tablet' })).toBe('The viewport is desktop or mobile')
  expect(refusalOf({ url: 'https://example.com', theme: 'sepia' })).toBe('The theme is light or dark')
  expect(refusalOf({ url: 'https://example.com', fullPage: 'yes' })).toBe('fullPage is true or false')
  expect(refusalOf(null)).toBe('Give the http or https address of the page to take a screenshot of')
})

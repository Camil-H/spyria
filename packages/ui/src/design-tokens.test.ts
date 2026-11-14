import { expect, test } from 'bun:test'
import { Glob } from 'bun'

const repositoryRoot = `${import.meta.dir}/../../..`
const paletteNames =
  'slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary|grey|aqua|light-neutral'
const colorUtilities =
  'bg|text|border(?:-[trblxyse])?|fill|stroke|outline|ring-offset|ring|inset-ring|inset-shadow|drop-shadow|text-shadow|shadow|divide|from|via|to|decoration|caret|accent'
const colorFunctions =
  '#|rgba?\\(|hsla?\\(|hwb\\(|oklch\\(|oklab\\(|lab\\(|lch\\(|color\\(|color-mix\\(|light-dark\\(|var\\(--palette'

const offScaleClasses: [string, RegExp][] = [
  ['a font size outside the type scale', /(?<![\w-])text-(?:base|lg|[2-9]?xl)(?![\w-])/],
  [
    'a font family or weight outside the theme',
    /(?<![\w-])font-(?:serif|thin|extralight|light|bold|extrabold|black)(?![\w-])/,
  ],
  [
    'an arbitrary font size, family, weight, tracking or leading',
    /(?<![\w-])(?:text-[[(](?!--color-|color:)|font-[[(]|tracking-[[(]|leading-[[(])/,
  ],
  [
    'an arbitrary typography or colour property',
    /\[(?:color|background-color|font-size|font-weight|font-family|letter-spacing|line-height):/,
  ],
  ['an arbitrary colour', new RegExp(`(?<![\\w-])(?:${colorUtilities})-\\[(?:${colorFunctions})`)],
  [
    'a palette colour instead of a semantic token',
    new RegExp(`(?<![\\w-])(?:${colorUtilities})-(?:${paletteNames})-\\d+|--palette-`),
  ],
  ['a colour value instead of a token', /light-dark\(\s*#/],
]

test('components use the design tokens of docs/guides/ui-design.md only', async () => {
  const sources: string[] = []
  const findings: string[] = []
  for (const pattern of ['apps/web/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'])
    for await (const path of new Glob(pattern).scan(repositoryRoot)) {
      if (/\.test\.tsx?$/.test(path)) continue
      sources.push(path)
      const lines = (await Bun.file(`${repositoryRoot}/${path}`).text()).split('\n')
      lines.forEach((line, index) => {
        for (const [problem, pattern] of offScaleClasses)
          if (pattern.test(line)) findings.push(`${path}:${index + 1} uses ${problem}: ${line.trim()}`)
      })
    }
  expect(sources.length).toBeGreaterThan(100)
  expect(findings).toEqual([])
})

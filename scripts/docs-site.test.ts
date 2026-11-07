import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSite, linkTargetOf, slugOf, withHeadingIds } from './docs-site.ts'

const work = mkdtempSync(join(tmpdir(), 'spyria-docs-site-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

test('headings get the anchors GitHub gives them', () => {
  expect(slugOf('Configuration: `.env.prod`')).toBe('configuration-envprod')
  expect(slugOf('Who can join and sign-in')).toBe('who-can-join-and-sign-in')
  expect(withHeadingIds('<h2>Runtime host on <code>this</code> machine</h2>')).toBe(
    '<h2 id="runtime-host-on-this-machine">Runtime host on <code>this</code> machine</h2>',
  )
})

test('links to a site page stay on the site, other files go to GitHub, and a missing file or heading is a problem', () => {
  const root = join(work, 'repository')
  mkdirSync(join(root, 'docs/guides'), { recursive: true })
  writeFileSync(join(root, 'docs/guides/a.md'), '# A\n\n## First step\n')
  writeFileSync(join(root, 'docs/guides/b.md'), '# B\n')
  const pages = [{ file: 'docs/guides/a.md', slug: 'index', title: 'A' }]
  const from = (href: string) => linkTargetOf(href, 'docs/guides/b.md', { pages, root })
  expect(from('./a.md#first-step')).toEqual({ href: './#first-step' })
  expect(from('https://opentofu.org')).toEqual({ href: 'https://opentofu.org' })
  expect(from('../guides/b.md')).toEqual({ href: 'https://github.com/Camil-H/spyria/blob/main/docs/guides/b.md' })
  expect(from('./missing.md').problem).toBe('docs/guides/b.md links to ./missing.md, which does not exist')
  expect(from('./a.md#no-such-step').problem).toBe(
    'docs/guides/b.md links to ./a.md#no-such-step, which has no such heading',
  )
})

test('the public docs build into a site with no broken link, the install script and the domain', () => {
  const output = join(work, 'site')
  expect(buildSite(output)).toEqual([])
  expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('<title>Install on one machine · Spyria</title>')
  expect(readFileSync(join(output, 'install'), 'utf8')).toStartWith('#!/bin/sh')
  expect(readFileSync(join(output, 'CNAME'), 'utf8')).toBe('spyria.dev\n')
})

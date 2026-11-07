import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

export type SitePage = { file: string; slug: string; title: string }

export const sitePages: SitePage[] = [
  { file: 'docs/guides/install.md', slug: 'index', title: 'Install on one machine' },
  { file: 'docs/guides/cloud.md', slug: 'cloud', title: 'Install on AWS, Azure or Google Cloud' },
  { file: 'docs/guides/who-can-join.md', slug: 'who-can-join', title: 'Who can join and sign-in' },
  { file: 'docs/guides/operations.md', slug: 'operations', title: 'Upgrades, backups and operations' },
  { file: 'docs/guides/troubleshooting.md', slug: 'troubleshooting', title: 'Troubleshooting' },
  { file: 'docs/guides/self-hosting.md', slug: 'manual-install', title: 'Manual install' },
  { file: 'docs/features/machines.md', slug: 'machines', title: 'Machines and runtime hosts' },
  { file: 'docs/features/admin.md', slug: 'administration', title: 'Administration' },
]
const repositoryUrl = 'https://github.com/Camil-H/spyria'
const siteDomain = 'spyria.dev'
const repositoryRoot = new URL('../', import.meta.url).pathname

const escaped = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const plainTextOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')

export const slugOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s/g, '-')

const headingSlugsOf = (markdown: string) =>
  new Set(
    markdown
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => slugOf(plainTextOf(Bun.markdown.html(line.replace(/^#+ /, ''))))),
  )

export const withHeadingIds = (html: string) =>
  html.replace(
    /<h([1-6])>(.*?)<\/h\1>/g,
    (_, level, inner) => `<h${level} id="${slugOf(plainTextOf(inner))}">${inner}</h${level}>`,
  )

export const linkTargetOf = (
  href: string,
  sourceFile: string,
  { pages, root }: { pages: readonly SitePage[]; root: string },
): { href: string; problem?: string } => {
  if (/^[a-z]+:/i.test(href) || href.startsWith('//')) return { href }
  const [path = '', anchor] = href.split('#')
  const target = path === '' ? sourceFile : normalize(join(dirname(sourceFile), decodeURIComponent(path)))
  const absolute = join(root, target)
  if (!existsSync(absolute)) return { href, problem: `${sourceFile} links to ${href}, which does not exist` }
  if (anchor && target.endsWith('.md') && !headingSlugsOf(readFileSync(absolute, 'utf8')).has(anchor))
    return { href, problem: `${sourceFile} links to ${href}, which has no such heading` }
  const page = pages.find((candidate) => candidate.file === target)
  const fragment = anchor ? `#${anchor}` : ''
  if (page) return { href: `${page.slug === 'index' ? './' : `${page.slug}.html`}${fragment}` }
  return { href: `${repositoryUrl}/blob/main/${relative('.', target)}${fragment}` }
}

const layoutOf = (page: SitePage, body: string, pages: readonly SitePage[]) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(page.title)} · Spyria</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header><a href="./" class="brand">Spyria</a><a href="${repositoryUrl}">GitHub</a></header>
<div class="page">
<nav aria-label="Guides"><ul>${pages
  .map(
    (candidate) =>
      `<li><a href="${candidate.slug === 'index' ? './' : `${candidate.slug}.html`}"${candidate === page ? ' aria-current="page"' : ''}>${escaped(candidate.title)}</a></li>`,
  )
  .join('')}</ul></nav>
<main>${body}</main>
</div>
</body>
</html>
`

const style = `:root { color-scheme: light dark; --ink: light-dark(#1d1d1f, #ececec); --muted: light-dark(#5f5f66, #a3a3ab); --line: light-dark(#e3e3e8, #34343a); --surface: light-dark(#f6f6f8, #1c1c20); --accent: light-dark(#3b4bd8, #8b97ff); }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 system-ui, sans-serif; color: var(--ink); background: light-dark(#fff, #121214); }
header { display: flex; justify-content: space-between; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--line); }
header a { color: var(--ink); text-decoration: none; } .brand { font-weight: 700; }
.page { display: grid; grid-template-columns: 16rem minmax(0, 48rem); gap: 2.5rem; padding: 2rem 1.5rem; max-width: 70rem; margin: 0 auto; }
nav ul { list-style: none; padding: 0; margin: 0; position: sticky; top: 1.5rem; }
nav a { display: block; padding: 0.3rem 0.6rem; border-radius: 6px; color: var(--muted); text-decoration: none; }
nav a[aria-current] { color: var(--ink); background: var(--surface); }
a { color: var(--accent); }
code { font: 0.9em ui-monospace, monospace; background: var(--surface); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--surface); padding: 1rem; border-radius: 8px; overflow-x: auto; } pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: 0.95em; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
@media (max-width: 52rem) { .page { grid-template-columns: 1fr; } nav ul { position: static; } }
`

export const buildSite = (outputDirectory: string, { root = repositoryRoot, pages = sitePages } = {}) => {
  const problems: string[] = []
  rmSync(outputDirectory, { recursive: true, force: true })
  mkdirSync(outputDirectory, { recursive: true })
  for (const page of pages) {
    const markdown = readFileSync(join(root, page.file), 'utf8')
    const body = withHeadingIds(Bun.markdown.html(markdown)).replace(/href="([^"]+)"/g, (_, href: string) => {
      const target = linkTargetOf(href.replaceAll('&amp;', '&'), page.file, { pages, root })
      if (target.problem) problems.push(target.problem)
      return `href="${escaped(target.href)}"`
    })
    writeFileSync(join(outputDirectory, `${page.slug}.html`), layoutOf(page, body, pages))
  }
  writeFileSync(join(outputDirectory, 'style.css'), style)
  copyFileSync(join(root, 'deploy/install.sh'), join(outputDirectory, 'install'))
  writeFileSync(join(outputDirectory, 'CNAME'), `${siteDomain}\n`)
  writeFileSync(join(outputDirectory, '.nojekyll'), '')
  return problems
}

if (import.meta.main) {
  const outputDirectory = process.argv[2] ?? join(repositoryRoot, 'dist/site')
  const problems = buildSite(outputDirectory)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log(`Built ${sitePages.length} pages into ${outputDirectory}`)
}

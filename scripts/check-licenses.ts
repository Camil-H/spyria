import { readFileSync } from 'node:fs'

const allowedLicenses = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'MIT-0',
  'Unlicense',
  'PostgreSQL',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Python-2.0',
])
const globalModules = '/usr/local/lib/node_modules'
const baseImagePackages = ['npm', 'corepack']
const listPackages = `const fs = require('fs'), path = require('path'), found = []
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = path.join(directory, entry.name)
    if (entry.name.startsWith('@')) { walk(folder); continue }
    try {
      const { name, version, license, licenses } = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
      if (name && version) found.push({ folder, name, version, license: license ?? licenses ?? null })
    } catch {}
    if (fs.existsSync(path.join(folder, 'node_modules'))) walk(path.join(folder, 'node_modules'))
  }
}
walk('${globalModules}')
console.log(JSON.stringify(found))`

type Found = { folder: string; name: string; version: string; license: unknown }

const packagesIn = (image: string): Found[] => {
  const listed = Bun.spawnSync(
    ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', listPackages],
    { stderr: 'inherit' },
  )
  if (listed.exitCode !== 0) throw new Error(`Could not list the packages of ${image}`)
  return JSON.parse(listed.stdout.toString())
}

const licenseNamesOf = (license: unknown): string[] => {
  if (typeof license === 'string') return [license]
  if (Array.isArray(license)) return license.flatMap(licenseNamesOf)
  if (license && typeof license === 'object' && 'type' in license) return licenseNamesOf(license.type)
  return []
}

export const isAllowedLicense = (license: unknown) => {
  const names = licenseNamesOf(license)
  return (
    names.length > 0 &&
    names.some((name) =>
      name
        .replace(/[()]/g, '')
        .split(' OR ')
        .some((choice) => choice.split(' AND ').every((part) => allowedLicenses.has(part.trim()))),
    )
  )
}

export const disallowedPackagesOf = (packages: readonly Found[], basePackages: readonly Found[]) => {
  const baseImageFolders = packages
    .filter(
      ({ folder, name, version }) =>
        baseImagePackages.includes(name) &&
        folder === `${globalModules}/${name}` &&
        basePackages.some((base) => base.folder === folder && base.version === version),
    )
    .map(({ folder }) => folder)
  return packages.filter(
    ({ folder, license }) =>
      !baseImageFolders.some((baseFolder) => folder === baseFolder || folder.startsWith(`${baseFolder}/`)) &&
      !isAllowedLicense(license),
  )
}

export const checkLicenses = (image: string) => {
  const dockerfile = new URL('../apps/agent/Dockerfile', import.meta.url).pathname
  const baseImage = readFileSync(dockerfile, 'utf8').match(/^FROM (\S+)/m)?.[1]
  if (!baseImage) throw new Error('No FROM line in apps/agent/Dockerfile')
  const disallowed = disallowedPackagesOf(packagesIn(image), packagesIn(baseImage))
  for (const { name, version, license } of disallowed)
    console.error(`${name}@${version} has the license ${JSON.stringify(license)}, which is not allowed`)
  return disallowed.length === 0
}

if (import.meta.main) {
  const image =
    process.argv[2] ?? readFileSync(new URL('../apps/agent/image-id', import.meta.url).pathname, 'utf8').trim()
  if (!checkLicenses(image)) process.exit(1)
  console.log(`Every package in ${image} has an allowed license`)
}

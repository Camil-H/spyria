import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const repositoryRoot = new URL('../', import.meta.url).pathname
const depcruise = [`${repositoryRoot}node_modules/.bin/depcruise`, '--config', '.dependency-cruiser.cjs']
const probeDirectoryName = '__boundary-probes__'
const { options } = (await import(`${repositoryRoot}.dependency-cruiser.cjs`)).default as {
  options: { exclude: { path: string[] } }
}
const excludedWithoutProbes = options.exclude.path.filter((path) => !path.includes(probeDirectoryName)).join('|')
const probeDirectories = [
  'packages/conversation/src/domain/__boundary-probes__',
  'packages/conversation/src/entrypoints/__boundary-probes__',
  'apps/host/src/__boundary-probes__',
]
const probes = [
  {
    file: 'packages/conversation/src/domain/__boundary-probes__/value-import.ts',
    rule: 'domain-imports-nothing-above',
    source: `import { rebuildMessages } from '../../integrations/postgres-message-projection.ts'\nexport const probe = rebuildMessages\n`,
  },
  {
    file: 'packages/conversation/src/domain/__boundary-probes__/type-import.ts',
    rule: 'domain-imports-no-third-party-package',
    source: `import type { ServerTransaction } from '@rocicorp/zero'\nexport type Probe = ServerTransaction\n`,
  },
  {
    file: 'packages/conversation/src/domain/__boundary-probes__/typescript-syntax.ts',
    rule: 'domain-imports-nothing-above',
    source: `import { rebuildMessages } from '../../integrations/postgres-message-projection.ts'\nenum ProbeKind { First }\nexport const probe = { kind: ProbeKind.First, rebuildMessages } satisfies Record<string, unknown>\n`,
  },
  {
    file: 'packages/conversation/src/entrypoints/__boundary-probes__/component.tsx',
    rule: 'entrypoints-never-import-integrations',
    source: `import { rebuildMessages } from '../../integrations/postgres-message-projection.ts'\nexport const Probe = () => <div>{String(rebuildMessages)}</div>\n`,
  },
  {
    file: 'apps/host/src/__boundary-probes__/spyria-import.ts',
    rule: 'host-and-agent-import-nothing-from-spyria',
    source: `import { DomainError } from '@spyria/kernel'\nexport const probe = DomainError\n`,
  },
]

type Cruised = { summary: { violations: { from: string; rule: { name: string } }[] } }

const cruise = Bun.spawnSync([...depcruise, 'apps', 'packages'], {
  cwd: repositoryRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (cruise.exitCode !== 0) process.exit(cruise.exitCode ?? 1)

const missedProbes = (() => {
  try {
    for (const { file, source } of probes) {
      mkdirSync(dirname(`${repositoryRoot}${file}`), { recursive: true })
      writeFileSync(`${repositoryRoot}${file}`, source)
    }
    const probeCruise = Bun.spawnSync(
      [...depcruise, '--exclude', excludedWithoutProbes, '--output-type', 'json', ...probeDirectories],
      { cwd: repositoryRoot, stderr: 'ignore' },
    )
    const { violations } = (JSON.parse(probeCruise.stdout.toString()) as Cruised).summary
    return probes.filter(
      ({ file, rule }) => !violations.some((violation) => violation.from === file && violation.rule.name === rule),
    )
  } finally {
    for (const directory of probeDirectories) rmSync(`${repositoryRoot}${directory}`, { recursive: true, force: true })
  }
})()

if (missedProbes.length > 0) {
  console.error(
    `dependency-cruiser no longer sees these forbidden imports, so its rules may pass without reading the sources (a TypeScript, @swc/core or dependency-cruiser upgrade?):\n${missedProbes.map(({ file, rule }) => `  ${rule}: ${file}`).join('\n')}`,
  )
  process.exit(1)
}
console.log(`Boundary probes caught: ${probes.length} forbidden imports, each by its rule`)

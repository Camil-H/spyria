const contexts = '(workspace|conversation|profile|panel|runtime|usage)'
const contextLayers = ['domain', 'contracts', 'operations', 'queries', 'integrations', 'entrypoints']
const contextEntry = (entry) => `^packages/${contexts}/src/${entry}\\.ts$`
const clientEntry = contextEntry('client')
const serverEntry = contextEntry('server')
const publishedEntry = contextEntry('published')
const clientModules = [
  '(^|/)node_modules/(react|react-dom|react-router|@radix-ui|lucide-react)/',
  `^packages/${contexts}/src/(entrypoints/.+\\.tsx$|client\\.ts$)`,
  '^packages/(ui|session)/',
  '^packages/db/src/useQuery\\.tsx$',
  '^packages/db/src/zero-store\\.ts$',
]
const serverOnlyModules = [
  '^packages/db/src/postgres(\\.ts$|/)',
  '(^|/node_modules/)(postgres|drizzle-orm|drizzle-kit)(/|$)',
  '^apps/server/',
]
const productionEntries = '^apps/(server/src/index\\.ts|web/src/main\\.tsx)$'
const testOnlyModules = ['(^|/)testing\\.ts$', '\\.test\\.tsx?$', '^apps/server/src/testing/', '^apps/web/e2e/']
const zeroTestHarness = '^apps/web/(e2e/|playwright\\.config\\.ts$)'
const zeroConfig = '^packages/db/drizzle-zero\\.config\\.ts$'
const layerRule = (name, layer, allowedLayers) => ({
  name,
  severity: 'error',
  from: { path: `^packages/${contexts}/src/${layer}/` },
  to: {
    path: '^packages/$1/src/',
    pathNot: [`^packages/$1/src/(${[layer, ...allowedLayers].join('|')})/`],
  },
})

module.exports = {
  forbidden: [
    layerRule('domain-imports-nothing-above', 'domain', []),
    layerRule('contracts-import-domain-only', 'contracts', ['domain']),
    layerRule('operations-import-contracts-and-domain', 'operations', ['contracts', 'domain']),
    layerRule('queries-import-domain-only', 'queries', ['domain']),
    layerRule('integrations-import-contracts-and-domain', 'integrations', ['contracts', 'domain']),
    {
      name: 'entrypoints-never-import-integrations',
      severity: 'error',
      from: {
        path: `^packages/${contexts}/src/entrypoints/`,
        pathNot: `^packages/${contexts}/src/entrypoints/(mutators|jobs|endpoints)\\.ts$`,
      },
      to: { path: '^packages/$1/src/integrations/' },
    },
    {
      name: 'layers-are-exhaustive',
      severity: 'error',
      from: { path: `^packages/${contexts}/src/` },
      to: { path: '^packages/$1/', pathNot: `^packages/$1/src/(${contextLayers.join('|')})/` },
    },
    {
      name: 'context-reachable-only-through-its-entries',
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/' },
      to: { path: `^packages/${contexts}/`, pathNot: ['^$1/$2/', contextEntry('(client|server|published)')] },
    },
    {
      name: 'client-entry-imported-only-by-web',
      severity: 'error',
      from: { pathNot: '^apps/web/' },
      to: { path: clientEntry },
    },
    {
      name: 'server-entry-imported-only-by-server-and-web-composition-root',
      severity: 'error',
      from: { pathNot: ['^apps/server/', '^apps/web/src/app/factory\\.ts$'] },
      to: { path: serverEntry },
    },
    {
      name: 'published-entry-imported-only-from-integrations',
      severity: 'error',
      from: { pathNot: `^packages/${contexts}/src/integrations/` },
      to: { path: publishedEntry },
    },
    {
      name: 'contexts-import-each-other-only-from-integrations',
      severity: 'error',
      from: { path: `^packages/${contexts}/src/`, pathNot: `^packages/${contexts}/src/integrations/` },
      to: { path: `^packages/${contexts}/`, pathNot: '^packages/$1/' },
    },
    {
      name: 'panel-imported-only-by-apps',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '^(apps/(web|server)|packages/panel)/' },
      to: { path: '^packages/panel/' },
    },
    {
      name: 'server-and-published-entries-never-reach-client-code',
      severity: 'error',
      from: { path: [serverEntry, publishedEntry, '^apps/server/'], pathNot: '\\.test\\.ts$' },
      to: { path: clientModules, reachable: true },
    },
    {
      name: 'postgres-drizzle-and-server-never-reach-client-code',
      severity: 'error',
      from: { path: ['^apps/web/', ...clientModules.slice(1)], pathNot: zeroTestHarness },
      to: { path: serverOnlyModules, reachable: true },
    },
    {
      name: 'test-only-modules-unreachable-from-production-entries',
      severity: 'error',
      from: { path: productionEntries },
      to: { path: testOnlyModules, reachable: true },
    },
    {
      name: 'zero-schema-queries-and-server-writes-never-reach-client-or-server-only-code',
      severity: 'error',
      from: { path: '^packages/db/src/(zero(-queries)?|server-writes)\\.ts$' },
      to: { path: [...clientModules, ...serverOnlyModules], reachable: true },
    },
    {
      name: 'drizzle-zero-config-imported-only-by-the-generated-zero-schema',
      severity: 'error',
      from: { pathNot: '^packages/db/src/zero\\.ts$' },
      to: { path: zeroConfig },
    },
    {
      name: 'server-imports-only-server-entries-kernel-and-db',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^(apps|packages)/', pathNot: ['^apps/server/', serverEntry, '^packages/(kernel|db)/'] },
    },
    {
      name: 'host-and-agent-import-nothing-from-hq',
      severity: 'error',
      from: { path: '^apps/(host|agent)/' },
      to: { path: ['^(apps|packages)/', '^@hq/'], pathNot: '^apps/$1/' },
    },
    {
      name: 'host-and-agent-imported-by-nothing',
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/' },
      to: { path: '^apps/(host|agent)/', pathNot: '^$1/$2/' },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'domain-imports-no-third-party-package',
      severity: 'error',
      from: { path: `^packages/${contexts}/src/domain/`, pathNot: ['\\.test\\.ts$', '(^|/)testing\\.ts$'] },
      to: { dependencyTypesNot: ['local'], pathNot: '^packages/kernel/' },
    },
    {
      name: 'kernel-imports-nothing',
      severity: 'error',
      from: { path: '^packages/kernel/', pathNot: '\\.test\\.ts$' },
      to: { pathNot: '^packages/kernel/' },
    },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: '^(apps|packages)/[^/]+/(node_modules|dist|test-results|playwright-report)/' },
    doNotFollow: { path: ['node_modules', zeroConfig] },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
  },
}

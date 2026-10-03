const contexts = '(workspace|conversation|profile|panel)'
const contextLayers = ['domain', 'contracts', 'operations', 'queries', 'integrations', 'entrypoints']
const contextCore = `^packages/${contexts}/src/core\\.ts$`
const contextEntries = `^packages/${contexts}/src/(surface|core)\\.ts$`
const clientModules = [
  '/node_modules/(react|react-dom|react-router)/',
  `^packages/${contexts}/src/entrypoints/`,
  '^packages/(ui|session)/',
]
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
      from: { path: `^packages/${contexts}/src/entrypoints/` },
      to: { path: '^packages/$1/src/integrations/' },
    },
    {
      name: 'layers-are-exhaustive',
      severity: 'error',
      from: { path: `^packages/${contexts}/src/` },
      to: { path: '^packages/$1/', pathNot: `^packages/$1/src/(${contextLayers.join('|')})/` },
    },
    {
      name: 'context-reachable-only-through-its-exports',
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/' },
      to: { path: `^packages/${contexts}/`, pathNot: ['^$1/$2/', contextEntries] },
    },
    {
      name: 'contexts-import-each-other-only-from-integrations',
      severity: 'error',
      from: { path: `^packages/${contexts}/src/`, pathNot: `^packages/${contexts}/src/integrations/` },
      to: { path: `^packages/${contexts}/`, pathNot: '^packages/$1/' },
    },
    {
      name: 'panel-imported-only-by-web',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '^(apps/web|packages/panel)/' },
      to: { path: '^packages/panel/' },
    },
    {
      name: 'web-imports-core-only-from-composition-root',
      severity: 'error',
      from: { path: '^apps/web/', pathNot: '^apps/web/src/app/factory\\.ts$' },
      to: { path: contextCore },
    },
    {
      name: 'core-and-server-never-reach-client-code',
      severity: 'error',
      from: { path: [contextCore, '^apps/server/'] },
      to: { path: clientModules, reachable: true },
    },
    {
      name: 'server-imports-only-cores-kernel-and-db',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^(apps|packages)/', pathNot: ['^apps/server/', contextCore, '^packages/(kernel|db)/'] },
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
      from: { path: `^packages/${contexts}/src/domain/`, pathNot: '\\.test\\.ts$' },
      to: { dependencyTypesNot: ['local'], pathNot: '^packages/kernel/' },
    },
    {
      name: 'kernel-imports-nothing',
      severity: 'error',
      from: { path: '^packages/kernel/' },
      to: { pathNot: '^packages/kernel/' },
    },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: '^(apps|packages)/[^/]+/(node_modules|dist|test-results|playwright-report)/' },
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
  },
}

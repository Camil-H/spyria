const contexts = '(workspace|profile|conversation|panel)'
const publishedSurface = '^apps/web/src/[^/]+/surface\\.tsx?$'
const contextLayers = ['domain', 'contracts', 'operations', 'queries', 'integrations', 'entrypoints']
const inContext = (layers) => `^apps/web/src/${contexts}/(${layers.join('|')})/`
const layerRule = (name, layer, allowedLayers) => ({
  name,
  severity: 'error',
  from: { path: `^apps/web/src/([^/]+)/${layer}/` },
  to: {
    path: `^apps/web/src/$1/`,
    pathNot: [`^apps/web/src/$1/(${[layer, ...allowedLayers].join('|')})/`],
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
      from: { path: '^apps/web/src/[^/]+/entrypoints/' },
      to: { path: '^apps/web/src/[^/]+/integrations/' },
    },
    {
      name: 'layers-are-exhaustive',
      severity: 'error',
      from: { path: `^apps/web/src/${contexts}/` },
      to: { path: '^apps/web/src/$1/', pathNot: inContext(contextLayers) },
    },
    {
      name: 'context-reachable-only-through-entrypoints-and-factory',
      severity: 'error',
      from: {
        path: '^apps/web/src/',
        pathNot: [`^apps/web/src/${contexts}/`, '^apps/web/src/app/factory\\.ts$'],
      },
      to: { path: '^apps/web/src/[^/]+/(domain|contracts|operations|queries|integrations)/' },
    },
    {
      name: 'contexts-do-not-import-each-other',
      severity: 'error',
      from: { path: `^apps/web/src/${contexts}/` },
      to: { path: `^apps/web/src/${contexts}/`, pathNot: ['^apps/web/src/$1/', publishedSurface] },
    },
    {
      name: 'surface-imported-only-by-integrations-and-app',
      severity: 'error',
      from: { path: `^apps/web/src/${contexts}/(domain|contracts|operations|queries|entrypoints)/` },
      to: { path: publishedSurface, pathNot: '^apps/web/src/$1/' },
    },
    {
      name: 'panel-surface-imported-only-by-app',
      severity: 'error',
      from: { path: '^apps/web/src/', pathNot: '^apps/web/src/(app|panel)/' },
      to: { path: '^apps/web/src/panel/surface\\.ts$' },
    },
    {
      name: 'contexts-import-app-only-through-session',
      severity: 'error',
      from: { path: `^apps/web/src/${contexts}/` },
      to: { path: '^apps/web/src/app/', pathNot: '^apps/web/src/app/session\\.tsx$' },
    },
    {
      name: 'domain-imports-no-third-party-package',
      severity: 'error',
      from: { path: '^apps/web/src/[^/]+/domain/', pathNot: '\\.test\\.ts$' },
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
    tsConfig: { fileName: 'apps/web/tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
  },
}

export const buildCacheLimit = '10GB'

export const pruneBuildCache = () =>
  Bun.spawnSync(['docker', 'builder', 'prune', '--force', '--max-used-space', buildCacheLimit], {
    stdout: 'ignore',
    stderr: 'inherit',
  })

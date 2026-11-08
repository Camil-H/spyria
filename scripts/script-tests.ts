export const unitTestOfScript = (changed: string, exists: (file: string) => boolean) => {
  if (!/^scripts\/[^/]+\.ts$/.test(changed)) return undefined
  const test = changed.endsWith('.test.ts') ? changed : changed.replace(/\.ts$/, '.test.ts')
  return exists(test) ? test : undefined
}

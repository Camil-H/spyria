import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    cacheDir: 'node_modules/.vite-zero',
    server: { proxy: { '/auth': process.env.HQ_SERVER_URL ?? 'http://localhost:3000' } },
  }),
)

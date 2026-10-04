import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config.ts'

const serverUrl = process.env.HQ_SERVER_URL ?? 'http://localhost:3000'

export default mergeConfig(
  baseConfig,
  defineConfig({
    cacheDir: 'node_modules/.vite-zero',
    server: { proxy: { '/auth': serverUrl, '/api': serverUrl } },
  }),
)

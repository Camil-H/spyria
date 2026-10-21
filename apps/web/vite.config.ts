import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const serverUrl = process.env.SPYRIA_SERVER_URL ?? 'http://localhost:3000'
const compressedFilePattern = /\.(js|css|html|svg|json)$/
const gzipped = promisify(gzip)
const brotliCompressed = promisify(brotliCompress)

const precompressedAssets = (): Plugin => ({
  name: 'spyria-precompressed-assets',
  apply: 'build',
  writeBundle: async ({ dir = '' }, bundle) => {
    const paths = Object.keys(bundle)
      .filter((fileName) => compressedFilePattern.test(fileName))
      .map((fileName) => join(dir, fileName))
    await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(path)
        await writeFile(`${path}.gz`, await gzipped(content, { level: 9 }))
        await writeFile(
          `${path}.br`,
          await brotliCompressed(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        )
      }),
    )
  },
})

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] }), precompressedAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': serverUrl,
      '/gateway-oauth': serverUrl,
      '/api': { target: serverUrl, ws: true },
      '^/host$': { target: serverUrl, ws: true },
    },
  },
})

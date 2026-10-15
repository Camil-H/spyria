import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const serverUrl = process.env.HQ_SERVER_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] })],
  build: { chunkSizeWarningLimit: 800 },
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

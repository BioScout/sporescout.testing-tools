import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const rootDir = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(rootDir, 'electron/main.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(rootDir, 'electron/preload.ts'),
      },
    },
  },
  renderer: {
    root: rootDir,
    define: {
      __SPORESCOUT_APP_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(rootDir, 'index.html'),
      },
    },
  },
})

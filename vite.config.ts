import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  define: {
    __SPORESCOUT_APP_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})

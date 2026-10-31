import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: { index: 'src/main/index.ts', core: 'src/core/index.ts', server: 'src/server/index.ts' }
      }
    }
  },
  // Sandboxed preloads must be CommonJS.
  preload: {
    build: {
      rolldownOptions: {
        input: { index: 'src/preload/index.ts' },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})

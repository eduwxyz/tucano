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
        input: { index: 'src/preload/index.ts', server: 'src/preload/server.ts' },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    // Two pages: the app's window, and the cards over every window (src/renderer/notice.html).
    build: {
      rolldownOptions: {
        input: { index: 'src/renderer/index.html', notice: 'src/renderer/notice.html' }
      }
    },
    plugins: [react()]
  }
})

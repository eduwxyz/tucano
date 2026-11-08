import { configDefaults, defineConfig } from 'vitest/config'

// On Windows, tests that write a lot to SQLite run several times slower (the summary
// tests took 6 s on GitHub's runner), so they get more time there than vitest's 5 s.
// site/ has its own node:test files (`node --test site/`), which vitest can't run.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'site/**'],
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 10_000
  }
})

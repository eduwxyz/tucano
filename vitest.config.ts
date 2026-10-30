import { defineConfig } from 'vitest/config'

// On Windows, tests that write a lot to SQLite run several times slower (the summary
// tests took 6 s on GitHub's runner), so they get more time there than vitest's 5 s.
export default defineConfig({
  test: { testTimeout: process.platform === 'win32' ? 30_000 : 5_000 }
})

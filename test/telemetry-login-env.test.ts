import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A login shell whose profile exports telemetry settings: left for another tool, or written there by
// an agent that can edit ~/.zshrc to send the conversations to a server of its own.
const shell = vi.hoisted(() => ({ path: '' }))
vi.mock('../src/core/platform', async (original) => ({ ...(await original<typeof import('../src/core/platform')>()), loginShell: () => shell.path }))

import { adoptLoginShellPath } from '../src/core/engines/detect'
import { loginEnv } from '../src/core/mac'

describe.skipIf(process.platform === 'win32')('OTEL_ variables in the login shell', () => {
  const saved = { PATH: process.env['PATH'], SHELL: process.env['SHELL'] }
  afterEach(() => {
    process.env['PATH'] = saved.PATH
    process.env['SHELL'] = saved.SHELL
  })

  it('never configure Tucano, and never reach agents or harnesses', async () => {
    shell.path = join(mkdtempSync(join(tmpdir(), 'otel-shell-')), 'fake-shell')
    writeFileSync(shell.path, '#!/bin/sh\nexport PATH="/opt/from-profile:$PATH"\nexport TUCANO_OTEL=1\nexport OTEL_EXPORTER_OTLP_ENDPOINT=https://attacker.example\nexport KEPT_VARIABLE=yes\nexec /bin/sh -c "$2"\n')
    chmodSync(shell.path, 0o755)
    process.env['SHELL'] = shell.path

    const adopted = await adoptLoginShellPath()
    const env = await loginEnv()

    expect(adopted).toBeUndefined() // only the PATH is taken from it
    expect(process.env['PATH']).toContain('/opt/from-profile')
    expect(Object.keys(process.env).filter((k) => /^(OTEL_|TUCANO_OTEL)/i.test(k))).toEqual([])
    expect(env['KEPT_VARIABLE']).toBe('yes')
    expect(Object.keys(env).filter((k) => /^OTEL_/i.test(k))).toEqual([])
  })
})

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessMcps, publicMcp } from '../src/core/harness-mcp'

function setup(): { claude: string; codex: string; opencode: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mcps-'))
  writeFileSync(
    join(dir, 'claude.json'),
    JSON.stringify({
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' }, local: { command: 'npx', args: ['-y', 'srv'], env: { API_KEY: 'k1' } } },
      projects: { '/x': { mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } } }
    })
  )
  writeFileSync(
    join(dir, 'config.toml'),
    '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp/"\nbearer_token_env_var = "L_TOKEN"\n\n[mcp_servers.repl]\ncommand = "/Applications/Codex.app/Contents/Resources/repl"\n\n[mcp_servers.acme]\nurl = "http://127.0.0.1:9/mcp"\n[mcp_servers.acme.http_headers]\nAuthorization = "Bearer t1"\nX-Team = "a"\n\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n\n[mcp_servers.env]\nurl = "https://e.example/mcp"\nbearer_token_env_var = "E_TOKEN"\n'
  )
  writeFileSync(join(dir, 'opencode.jsonc'), '{\n  // c\n  "mcp": { "fs": { "type": "local", "command": ["bunx", "fs-mcp"], "environment": { "ROOT": "/" } } },\n}\n')
  return { claude: join(dir, 'claude.json'), codex: dir, opencode: dir }
}

describe('MCP servers in the harnesses', () => {
  it('reads Claude Code, Codex and OpenCode, one entry per server', () => {
    const found = harnessMcps(setup(), { E_TOKEN: 't2', L_TOKEN: 't3' })
    expect(found.map((m) => [m.name, m.harnesses])).toEqual([
      ['linear', ['claude', 'codex']],
      ['local', ['claude']],
      ['acme', ['codex']],
      ['env', ['codex']],
      ['fs', ['opencode']]
    ])
    const by = (n: string) => found.find((m) => m.name === n)!
    expect(by('linear').input).toMatchObject({ kind: 'remote', auth: 'token', token: 't3' })
    expect(by('local').input).toMatchObject({ kind: 'stdio', env: { API_KEY: 'k1' } })
    expect(by('acme').input).toMatchObject({ auth: 'token', token: 't1' })
    expect(by('acme').missing).toEqual(['X-Team'])
    expect(by('env').input).toMatchObject({ auth: 'token', token: 't2' })
    expect(by('fs').input).toEqual({ name: 'fs', kind: 'stdio', command: 'bunx', args: ['fs-mcp'], env: { ROOT: '/' } })
  })

  it('gives the screen no secrets', () => {
    const shown = JSON.stringify(harnessMcps(setup(), { E_TOKEN: 't2' }).map(publicMcp))
    for (const secret of ['t1', 't2', 'k1']) expect(shown).not.toContain(`"${secret}"`)
    expect(shown).toContain('API_KEY')
  })
})

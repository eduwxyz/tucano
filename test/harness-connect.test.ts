import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { connectHarness } from '../src/core/harness-connect'
import { claudeMcps, codexMcps, opencodeMcps } from '../src/core/harness-mcp'

const home = (): string => mkdtempSync(join(tmpdir(), 'tucano-connect-'))
const o = (h: string, extra: Record<string, unknown> = {}) => ({ url: 'http://127.0.0.1:47817/mcp', key: 'tk_one', name: 'tucano', home: h, env: { XDG_CONFIG_HOME: join(h, '.config') }, ...extra })

describe('connecting a harness in one click', () => {
  it("writes Claude Code's entry next to what was there, and reads back as a server with its token", async () => {
    const h = home()
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }))
    expect(await connectHarness('claude', o(h))).toMatchObject({ done: true, where: '~/.claude.json', name: 'tucano' })
    const file = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf8')) as { numStartups: number; mcpServers: Record<string, unknown> }
    expect(file.numStartups).toBe(3)
    expect(Object.keys(file.mcpServers)).toEqual(['linear', 'tucano'])
    const found = claudeMcps(join(h, '.claude.json')).find((m) => m.name === 'tucano')!
    expect(found.input).toMatchObject({ url: 'http://127.0.0.1:47817/mcp', auth: 'token', token: 'tk_one' })
  })

  it('asks before replacing an entry of the same name', async () => {
    const h = home()
    await connectHarness('claude', o(h))
    expect(await connectHarness('claude', o(h, { key: 'tk_two' }))).toMatchObject({ done: false, exists: true })
    expect(readFileSync(join(h, '.claude.json'), 'utf8')).toContain('tk_one')
    expect(await connectHarness('claude', o(h, { key: 'tk_two', replace: true }))).toMatchObject({ done: true })
    expect(readFileSync(join(h, '.claude.json'), 'utf8')).toContain('tk_two')
  })

  it("puts Codex's table in config.toml as text, keeping the rest and its comments, and swaps it whole", async () => {
    const h = home()
    mkdirSync(join(h, '.codex'))
    const before = '# my settings\nmodel = "gpt-5.6-luna"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n'
    writeFileSync(join(h, '.codex', 'config.toml'), before)
    expect(await connectHarness('codex', o(h))).toMatchObject({ done: true })
    const once = readFileSync(join(h, '.codex', 'config.toml'), 'utf8')
    expect(once.startsWith(before)).toBe(true)
    expect(codexMcps(join(h, '.codex'), {}).find((m) => m.name === 'tucano')!.input).toMatchObject({ url: 'http://127.0.0.1:47817/mcp', auth: 'token', token: 'tk_one' })
    expect(await connectHarness('codex', o(h, { key: 'tk_two' }))).toMatchObject({ exists: true })
    // Replaced in place, with a table after it left as it was.
    writeFileSync(join(h, '.codex', 'config.toml'), `${once}\n[profiles.fast]\nmodel = "x"\n`)
    expect(await connectHarness('codex', o(h, { key: 'tk_two', replace: true }))).toMatchObject({ done: true })
    const twice = readFileSync(join(h, '.codex', 'config.toml'), 'utf8')
    expect(twice).not.toContain('tk_one')
    expect(twice.match(/\[mcp_servers\.tucano\]/g)).toHaveLength(1)
    const toml = parse(twice) as { model: string; profiles: { fast: { model: string } }; mcp_servers: Record<string, { url: string }> }
    expect(toml.model).toBe('gpt-5.6-luna')
    expect(toml.profiles.fast.model).toBe('x')
    expect(Object.keys(toml.mcp_servers).sort()).toEqual(['linear', 'tucano'])
  })

  it("writes Cursor's mcp.json, made if missing", async () => {
    const h = home()
    expect(await connectHarness('cursor', o(h))).toMatchObject({ done: true, where: '~/.cursor/mcp.json' })
    expect(JSON.parse(readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { tucano: { url: 'http://127.0.0.1:47817/mcp', headers: { Authorization: 'Bearer tk_one' } } } })
  })

  it("writes OpenCode's, and leaves one with comments alone (rewriting would lose them)", async () => {
    const h = home()
    const dir = join(h, '.config', 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode.json'), '{ "theme": "tokyonight" }')
    expect(await connectHarness('opencode', o(h))).toMatchObject({ done: true })
    expect(opencodeMcps(dir).find((m) => m.name === 'tucano')!.input).toMatchObject({ auth: 'token', token: 'tk_one' })
    const other = home()
    const d2 = join(other, '.config', 'opencode')
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, 'opencode.jsonc'), '{\n  // mine\n  "theme": "x"\n}')
    const r = await connectHarness('opencode', o(other))
    expect(r.done).toBe(false)
    expect(r.error).toMatch(/coment|comment/)
    expect(readFileSync(join(d2, 'opencode.jsonc'), 'utf8')).toContain('// mine')
  })

  it("doesn't touch a broken JSON file", async () => {
    const h = home()
    writeFileSync(join(h, '.claude.json'), '{ broken')
    const r = await connectHarness('claude', o(h))
    expect(r.done).toBe(false)
    expect(readFileSync(join(h, '.claude.json'), 'utf8')).toBe('{ broken')
  })
})

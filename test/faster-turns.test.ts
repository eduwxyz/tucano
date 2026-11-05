import { describe, expect, it } from 'vitest'
import { claudeEnv } from '../src/core/engines/claude'
import { MAX_RESULT_BYTES, resultText } from '../src/core/runs'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

describe('a tool result handed back to the model', () => {
  it('goes as it is under the cut', () => {
    const t = 'x'.repeat(MAX_RESULT_BYTES)
    expect(resultText(text(t))).toBe(t)
  })

  it('is cut in bytes under Claude Code’s own cut, and says how to get the rest', () => {
    const out = resultText(text('a'.repeat(60_000)))
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(50_000)
    expect(out.startsWith('a'.repeat(MAX_RESULT_BYTES))).toBe(true)
    expect(out).toMatch(/pagina|paginat/i)
  })

  it('counts accents as the bytes they are, and never splits a character', () => {
    const out = resultText(text('ção '.repeat(20_000))) // 6 bytes each
    const kept = out.slice(0, out.lastIndexOf('\n'))
    expect(Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(kept).not.toContain('�')
  })
})

describe('the environment Claude Code runs in', () => {
  it('turns off the post-turn summary that holds every reply', () => {
    expect(claudeEnv({ env: {} })['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1')
  })

  it('keeps the person’s own provider settings and the account', () => {
    const env = claudeEnv({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }, '/accounts/a')
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://gw.example')
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/accounts/a')
    expect(env['MCP_TOOL_TIMEOUT']).toBe('900000')
  })
})

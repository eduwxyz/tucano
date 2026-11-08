// A harness's failure as people read it: one plain line with what to do, never a stack or a path;
// the raw text only for "Ver detalhes".
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { explainEngineError, providerOf } from '../src/shared/engine-errors'

afterEach(() => setLang('pt'))

const PI_EXPIRED = `OAuth refresh failed for anthropic: 400 {"type":"error","error":{"type":"invalid_grant","message":"Refresh token expired"}}
    at postJson (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/auth/oauth.js:88:11)`

describe('a failing harness, in plain words', () => {
  it("Pi's expired Anthropic login: who, where, and what to do", () => {
    const p = explainEngineError('pi', PI_EXPIRED)
    expect(p.kind).toBe('login')
    expect(p.line).toBe('O login da Anthropic no Pi expirou. Entre de novo no Pi pra usar.')
    expect(p.line).not.toMatch(/file:|node_modules|at postJson|\n/)
    expect(p.details).toContain('at postJson')
    setLang('en')
    expect(explainEngineError('pi', PI_EXPIRED).line).toBe('The Anthropic sign-in in Pi expired. Sign in to Pi again to use it.')
  })

  it('other logins: 401, not logged in, an invalid key; the harness is the provider for Claude Code and Codex', () => {
    expect(explainEngineError('claude', 'API Error: 401 {"error":"authentication_error"}').line).toBe('O login do Claude Code não está valendo. Entre de novo no Claude Code pra usar.')
    expect(explainEngineError('codex', 'Not logged in. Run codex login.').kind).toBe('login')
    expect(explainEngineError('opencode', 'Invalid API key for openai').line).toBe('O login da OpenAI no OpenCode não está valendo. Entre de novo no OpenCode pra usar.')
    expect(explainEngineError('gemini', 'Please sign in again').kind).toBe('login')
  })

  it('a limit and a timeout get their own line', () => {
    expect(explainEngineError('claude', "You've hit your limit · resets 5pm")).toMatchObject({ kind: 'limit', line: 'O Claude Code chegou no limite de uso. Tente de novo mais tarde.' })
    expect(explainEngineError('codex', 'The operation was aborted due to timeout')).toMatchObject({ kind: 'timeout' })
  })

  it("anything else: a short generic line, the raw text kept for details; the core's own plain lines pass", () => {
    const p = explainEngineError('cursor', 'TypeError: Cannot read properties of undefined\n    at run (/usr/local/lib/cursor/index.js:1:2)')
    expect(p).toMatchObject({ kind: 'other', line: 'O Cursor CLI não funcionou agora.' })
    expect(p.details).toContain('/usr/local/lib')
    expect(explainEngineError('codex', 'O modelo não respondeu.')).toEqual({ kind: 'other', line: 'O modelo não respondeu.' })
  })

  it('names the provider the message is about', () => {
    expect(providerOf('OAuth refresh failed for anthropic: x')).toBe('Anthropic')
    expect(providerOf('google token expired')).toBe('Google')
    expect(providerOf('something')).toBeUndefined()
  })
})

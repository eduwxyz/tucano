import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeEngine, claudeEnv } from '../src/core/engines/claude'
import { anthropicModel, modelInfo, thinkingOff } from '../src/shared/types'

describe('thinking on a model behind a gateway that isn’t Anthropic’s', () => {
  it('tells Anthropic’s models apart from the others, by the name the CLI gets', () => {
    for (const m of ['sonnet', 'opus', 'haiku', 'claude-sonnet-4-5', 'us.anthropic.claude-opus-4-1']) expect(anthropicModel(m)).toBe(true)
    for (const m of ['deepseek-chat', 'deepseek-reasoner', 'kimi-k2', 'glm-4.6']) expect(anthropicModel(m)).toBe(false)
    expect(modelInfo('claude:deepseek-chat')?.id).toBe('deepseek-chat') // the stored id's "claude:" is the engine, not the model
  })

  it('is off at low and medium effort, on at high and max; Anthropic’s models keep theirs', () => {
    expect(thinkingOff('deepseek-chat', 'low')).toBe(true)
    expect(thinkingOff('deepseek-chat', 'medium')).toBe(true)
    expect(thinkingOff('deepseek-chat', 'high')).toBe(false)
    expect(thinkingOff('deepseek-reasoner', 'xhigh')).toBe(false)
    expect(thinkingOff('sonnet', 'low')).toBe(false)
  })

  it('goes in the environment Claude Code runs with, under the gateway’s own settings', () => {
    expect(claudeEnv({ env: {} }, undefined, undefined, true)['CLAUDE_CODE_DISABLE_THINKING']).toBe('1')
    expect(claudeEnv({ env: {} }, undefined, undefined, false)['CLAUDE_CODE_DISABLE_THINKING']).toBe(process.env['CLAUDE_CODE_DISABLE_THINKING'])
    expect(claudeEnv({ env: { CLAUDE_CODE_DISABLE_THINKING: '0' } }, undefined, undefined, true)['CLAUDE_CODE_DISABLE_THINKING']).toBe('0')
  })

  it.skipIf(process.platform === 'win32')('the CLI gets CLAUDE_CODE_DISABLE_THINKING only then, and the person’s own setting wins', async () => {
    const { writeFileSync, chmodSync } = await import('node:fs')
    const bin = join(mkdtempSync(join(tmpdir(), 'gt-')), 'claude')
    writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"[$CLAUDE_CODE_DISABLE_THINKING]\\",\\"usage\\":{}}"\n')
    chmodSync(bin, 0o755)
    const run = async (model: string, effort: 'low' | 'high', env: Record<string, string> = {}): Promise<string> => {
      let text = ''
      for await (const ev of claudeEngine(() => bin, async () => ({ env })).run({ model, effort, system: 's', prompt: 'oi', cwd: tmpdir(), signal: new AbortController().signal } as never)) if (ev.type === 'done') text = ev.text
      return text
    }
    expect(await run('deepseek-chat', 'low')).toBe('[1]')
    expect(await run('deepseek-chat', 'high')).toBe('[]')
    expect(await run('sonnet', 'low')).toBe('[]')
    expect(await run('deepseek-chat', 'low', { CLAUDE_CODE_DISABLE_THINKING: '0' })).toBe('[0]')
  })
})

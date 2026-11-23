// Which quota a bot's header bar stands for. A model id names its harness, and inside a harness that
// hosts several logins it names the login too: that login is the provider whose quota runs out. What
// is checked here is that a real stored id reads correctly, that a fallback counts as its own
// provider, and that two bars at most come out of any conversation.
import { describe, expect, it } from 'vitest'
import { agentProviders, providerOf } from '../src/shared/quota-provider'

describe('providerOf', () => {
  it('reads the login a harness hosts from the model id', () => {
    expect(providerOf('pi:opencode-go/deepseek-v4.1-flash')).toBe('opencode-go')
    expect(providerOf('pi:xai-oauth/grok-4.6')).toBe('xai-oauth')
    expect(providerOf('pi:zai/glm-5.3')).toBe('zai')
    expect(providerOf('pi:anthropic/claude-sonnet-4-5')).toBe('anthropic-claude-code')
  })

  it('reads a harness with one subscription of its own', () => {
    expect(providerOf('codex:gpt-6.1-sol')).toBe('openai-codex')
    expect(providerOf('claude:claude-opus-4-6')).toBe('anthropic-claude-code')
    expect(providerOf('grok:grok-4.6')).toBe('xai-oauth')
  })

  it('lets a named login decide, so a second account is its own provider', () => {
    const accounts = [{ id: 'acc-work', engine: 'claude', name: 'Work' }] as never
    expect(providerOf('claude:claude-opus-4-6', accounts, 'acc-work')).toBe('anthropic-claude-code')
  })

  it('names no provider for a harness that hosts anything and says nothing', () => {
    expect(providerOf('hermes:deepseek-v4.1-flash')).toBeUndefined()
    expect(providerOf('cursor:auto')).toBeUndefined()
    expect(providerOf('')).toBeUndefined()
    expect(providerOf(undefined)).toBeUndefined()
  })
})

describe('agentProviders', () => {
  it('lists the main model provider and then its fallback, without repeating one', () => {
    const bots = [
      { modelId: 'pi:opencode-go/deepseek-v4.1-flash', fallbackModelId: 'pi:opencode-go/beam-free' },
      { modelId: 'codex:gpt-6.1-sol', fallbackModelId: 'pi:opencode-go/beam-free' }
    ]
    expect(agentProviders(bots)).toEqual(['opencode-go', 'openai-codex'])
  })

  it('stops at two, whichever bots come first', () => {
    const bots = [
      { modelId: 'codex:gpt-6.1-sol', fallbackModelId: 'pi:opencode-go/beam-free' },
      { modelId: 'pi:xai-oauth/grok-4.6' },
      { modelId: 'pi:zai/glm-5.3' }
    ]
    expect(agentProviders(bots)).toEqual(['openai-codex', 'opencode-go'])
  })

  it('gives nothing for bots whose harness names no provider', () => {
    expect(agentProviders([{ modelId: 'hermes:deepseek-v4.1-flash' }])).toEqual([])
  })
})

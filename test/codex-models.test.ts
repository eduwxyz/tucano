import { describe, expect, it } from 'vitest'
import { parseCodexCatalog } from '../src/core/engines/detect'
import { availableModels } from '../src/core/tuca'
import { codexValue, modelInfo, rememberModels, type Settings } from '../src/shared/types'

// What `codex debug models` prints (trimmed): newest first by priority, some hidden.
const CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', description: 'Older fast and efficient model.', visibility: 'list', priority: 9 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list', priority: 2 },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 4 }
  ]
})

describe("Codex's own catalog", () => {
  it('lists what Codex shows, newest first, with its names, and leaves hidden models out', () => {
    expect(parseCodexCatalog(CATALOG)).toEqual([
      { slug: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
      { slug: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' }
    ])
  })

  it('keeps priority 0 at the top, and one with no priority last', () => {
    const list = parseCodexCatalog(JSON.stringify([{ slug: 'none' }, { slug: 'second', priority: 1 }, { slug: 'first', priority: 0 }]))
    expect(list.map((m) => m.slug)).toEqual(['first', 'second', 'none'])
  })

  it('takes a bare list (the cache file) and bad output without breaking', () => {
    expect(parseCodexCatalog(JSON.stringify([{ slug: 'x' }]))).toEqual([{ slug: 'x', label: 'x' }])
    expect(parseCodexCatalog('')).toEqual([])
    expect(parseCodexCatalog('{"error":"not logged in"}')).toEqual([])
  })

  it("keeps the app's own ids for the models agents already use, and names new ones", () => {
    expect(codexValue('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(codexValue('gpt-6-astra')).toBe('codex:gpt-6-astra')
    rememberModels([{ id: 'gpt-6-astra', engine: 'codex', label: 'GPT-6-Astra', hint: 'Frontier' }])
    expect(modelInfo('codex:gpt-6-astra')).toMatchObject({ id: 'gpt-6-astra', engine: 'codex', label: 'GPT-6-Astra' })
  })

  it("gives Tuca the catalog's models instead of the app's Codex list", () => {
    const off = { installed: false, loggedIn: false }
    const s = { engines: { claude: off, codex: { installed: true, loggedIn: true, route: 'plan' }, opencode: off, pi: off, gemini: off, cursor: off, copilot: off } } as unknown as Pick<Settings, 'engines'>
    expect(availableModels(s, { codex: ['gpt-6-astra', 'gpt-5.6-luna'] })).toEqual([
      { id: 'codex:gpt-6-astra', label: 'Codex · GPT-6-Astra' },
      { id: 'gpt-5.6-luna', label: 'Codex · GPT-5.6 Luna' }
    ])
    // No catalog (an old Codex): the app's list, as before.
    expect(availableModels(s).map((m) => m.id)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'])
  })
})

describe("Tuca's list of models", () => {
  it('includes the Gemini models when the Gemini CLI is signed in', () => {
    const off = { installed: false, loggedIn: false }
    const s = { engines: { claude: off, codex: off, opencode: off, pi: off, gemini: { installed: true, loggedIn: true, route: 'providers' } } } as unknown as Pick<Settings, 'engines'>
    expect(availableModels(s, { gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'] })).toEqual([
      { id: 'gemini:gemini-2.5-pro', label: 'Gemini CLI · gemini-2.5-pro' },
      { id: 'gemini:gemini-2.5-flash', label: 'Gemini CLI · gemini-2.5-flash' }
    ])
  })

  it('includes the Cursor models when the Cursor CLI is signed in', () => {
    const off = { installed: false, loggedIn: false }
    const s = { engines: { claude: off, codex: off, opencode: off, pi: off, gemini: off, cursor: { installed: true, loggedIn: true, route: 'providers' }, copilot: off } } as unknown as Pick<Settings, 'engines'>
    expect(availableModels(s, { cursor: ['auto', 'claude-opus-5-5-high'] })).toEqual([
      { id: 'cursor:auto', label: 'Cursor CLI · auto' },
      { id: 'cursor:claude-opus-5-5-high', label: 'Cursor CLI · claude-opus-5-5-high' }
    ])
  })

  it('includes the Grok models when the Grok CLI is signed in', () => {
    const off = { installed: false, loggedIn: false }
    const s = { engines: { claude: off, codex: off, opencode: off, pi: off, gemini: off, cursor: off, grok: { installed: true, loggedIn: true, route: 'plan' } } } as unknown as Pick<Settings, 'engines'>
    expect(availableModels(s, { grok: ['grok-4.7', 'grok-4.5'] })).toEqual([
      { id: 'grok:grok-4.7', label: 'Grok · grok-4.7' },
      { id: 'grok:grok-4.5', label: 'Grok · grok-4.5' }
    ])
  })
})

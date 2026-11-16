// Colour themes: a few seeds per colour scheme, the rest derived. The Tucano theme must look
// exactly as styles.css does, and every other theme must read (WCAG AA).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AA_LARGE, AA_TEXT, colorSchemeOf, contrast, DEFAULT_THEME_ID, hueOf, readable, THEME_TOKENS, THEMES, themeById, themeTokens, themeVariables, type Theme } from '../src/shared/themes'

const css = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles.css'), 'utf8')
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+):\s*(.+?);(?:\s*\/\*.*\*\/)?\s*$/gm)].map((m) => [m[1]!, m[2]!]))
}
const stylesheet = { light: block(':root'), dark: block(":root[data-theme='dark']") }

const derivedOnly = THEMES.filter((t) => t.id !== DEFAULT_THEME_ID)
const tucanoSeedsOnly: Theme = { id: 'seeds', name: 'Seeds', light: { ...THEMES[0]!.light, tokens: undefined }, dark: { ...THEMES[0]!.dark, tokens: undefined } }

describe('the Tucano theme', () => {
  it.each(['light', 'dark'] as const)("sets every %s token to exactly what styles.css has", (scheme) => {
    const variables = themeVariables(themeById(DEFAULT_THEME_ID), scheme)
    for (const [name, value] of Object.entries(variables)) expect([name, value]).toEqual([name, stylesheet[scheme][name]])
    expect(Object.keys(variables)).toHaveLength(THEME_TOKENS.length + 1)
  })

  it('is what an unknown or unset theme falls back to', () => {
    expect(themeById(undefined).id).toBe(DEFAULT_THEME_ID)
    expect(themeById('gone').id).toBe(DEFAULT_THEME_ID)
  })
})

describe('a derived theme', () => {
  it.each([...derivedOnly, tucanoSeedsOnly].flatMap((t) => (['light', 'dark'] as const).map((s) => [t.id, s, t] as const)))('%s (%s) reads', (_id, scheme, theme) => {
    const k = themeTokens(theme, scheme)
    for (const surface of [k.bg, k.sidebar, k.panel]) {
      expect(contrast(k.text, surface)).toBeGreaterThanOrEqual(AA_TEXT)
      expect(contrast(k['text-2'], surface)).toBeGreaterThanOrEqual(AA_TEXT)
      expect(contrast(k['text-3'], surface)).toBeGreaterThanOrEqual(AA_LARGE)
    }
    expect(contrast(k.text, k.bubble)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(k['selected-ink'], k.selected)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(k['accent-text'], k.accent)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(k['primary-text'], k.primary)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(k['toast-ink'], k['toast-bg'])).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('keeps the seeds it is given when they already read', () => {
    for (const theme of derivedOnly)
      for (const scheme of ['light', 'dark'] as const) {
        expect(themeTokens(theme, scheme).bg).toBe(theme[scheme].canvas)
        expect(themeTokens(theme, scheme).accent).toBe(theme[scheme].accent)
      }
  })

  it('nudges an accent that does not read until it does, darker on a light theme and lighter on a dark one', () => {
    const lemon: Theme = { id: 'lemon', name: 'Lemon', light: { canvas: '#fafaf5', accent: '#f5d90a' }, dark: { canvas: '#101010', accent: '#3a2a8a' } }
    const light = themeTokens(lemon, 'light')
    const dark = themeTokens(lemon, 'dark')
    expect(light.accent).not.toBe('#f5d90a')
    expect(contrast(light['accent-text'], light.accent)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(dark['accent-text'], dark.accent)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(readable('#777777', ['#ffffff'], AA_TEXT)).not.toBe('#777777')
    expect(readable('#000000', ['#ffffff'], AA_TEXT)).toBe('#000000')
  })

  it('takes a direct override over what it derives', () => {
    const theme: Theme = { id: 'x', name: 'X', light: { canvas: '#f0f0f0', accent: '#225588', tokens: { bubble: '#abcdef' } }, dark: { canvas: '#111111', accent: '#88aadd' } }
    expect(themeTokens(theme, 'light').bubble).toBe('#abcdef')
  })

  it('is the same every time, in plain CSS colours', () => {
    for (const theme of THEMES)
      for (const scheme of ['light', 'dark'] as const) {
        const variables = themeVariables(theme, scheme)
        expect(themeVariables(theme, scheme)).toEqual(variables)
        for (const [name, value] of Object.entries(variables)) expect([name, value]).toEqual([name, expect.stringMatching(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\)|url\(.+\))$/)])
      }
  })
})

describe('the presets', () => {
  it('have unique ids and names, and a light and a dark variant each', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length)
    for (const t of THEMES) expect(themeTokens(t, 'light').bg).not.toBe(themeTokens(t, 'dark').bg)
  })

  it('are eight besides Tucano, each with an accent of its own hue', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['Tucano', 'Sertão', 'Cerrado', 'Mata Atlântica', 'Lençóis', 'Rio Negro', 'Pantanal', 'Açaí', 'Ipê'])
    for (const scheme of ['light', 'dark'] as const) {
      const hues = THEMES.map((t) => hueOf(themeTokens(t, scheme).accent))
      for (const [i, a] of hues.entries())
        for (const b of hues.slice(i + 1)) expect(Math.min(Math.abs(a - b), 360 - Math.abs(a - b))).toBeGreaterThanOrEqual(30)
    }
  })

  it('follow the system scheme only when the mode is System', () => {
    expect(colorSchemeOf('system', true)).toBe('dark')
    expect(colorSchemeOf('system', false)).toBe('light')
    expect(colorSchemeOf('light', true)).toBe('light')
    expect(colorSchemeOf('dark', false)).toBe('dark')
  })
})

// Omarchy (an Arch Linux setup) keeps the desktop's current theme as a flat colors.toml:
// `key = "#rrggbb"` lines, with `mode = "dark"` or `"light"`. Every theme has a background
// and a foreground; most also name an accent, the derived shades (dark_background, …) and
// the semantic colours, and a theme converted from an old alacritty.toml has only color0–15.
// This turns that file into Tucano's own colour tokens, so the window can follow the desktop.

export type OmarchyMode = 'light' | 'dark'

// What the window paints: the tokens to set on the page, the side they belong to, and the
// background main gives the window before the page draws.
export interface OmarchyPalette {
  mode: OmarchyMode
  background: string
  vars: Record<`--${string}`, string>
}

// Read by the window from main (src/main/omarchy.ts): null off Omarchy.
export interface OmarchyState extends OmarchyPalette {
  on: boolean
  name: string // the theme's folder name, "tokyo-night"
}

// key → value, for the lines that hold one. Quoted values may carry a '#', which outside
// quotes starts a comment.
export function parseColorsToml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line)
    if (m) out[m[1]!] = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  }
  return out
}

type Rgb = [number, number, number]

// "#rgb", "#rrggbb" or alacritty's "0xrrggbb"; anything else is not a colour.
export function hexColor(value: string | undefined): string | undefined {
  const m = /^(?:#|0x)([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value?.trim() ?? '')
  if (!m) return undefined
  const h = m[1]!.toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb
const hex = (c: Rgb): string => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
// `amount` of `b` into `a`, in sRGB: what Omarchy's own templates do with `mix`.
const mix = (a: string, b: string, amount: number): string => {
  const x = rgb(a)
  const y = rgb(b)
  return hex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as Rgb)
}
const alpha = (color: string, a: number): string => `rgba(${rgb(color).join(', ')}, ${a})`

// WCAG relative luminance and contrast ratio.
const luminance = (color: string): number => {
  const [r, g, b] = rgb(color).map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// Of the candidates, the first that reads on `bg` (AA, 4.5:1), or the one that reads best.
const readable = (bg: string, ...candidates: string[]): string =>
  candidates.find((c) => contrast(bg, c) >= 4.5) ?? candidates.reduce((best, c) => (contrast(bg, c) > contrast(bg, best) ? c : best))

// The Select component's caret is an SVG in a url(), so its stroke is written into it.
const caret = (color: string): string =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23${color.slice(1)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`

// The tokens for a colors.toml, or null when it has no background and foreground to build on.
// The agents' own colours (--c-*) stay Tucano's: they tell agents apart, not the desktop.
export function omarchyPalette(text: string): OmarchyPalette | null {
  const raw = parseColorsToml(text)
  const color = (...keys: string[]): string | undefined => keys.map((k) => hexColor(raw[k])).find(Boolean)
  const bg = color('background', 'color0')
  const fg = color('foreground', 'color7')
  if (!bg || !fg) return null
  const mode: OmarchyMode = raw['mode'] === 'light' || raw['mode'] === 'dark' ? raw['mode'] : luminance(bg) < luminance(fg) ? 'dark' : 'light'
  const dark = mode === 'dark'
  const accent = color('accent', 'blue', 'color4') ?? fg
  const ok = color('green', 'color2') ?? (dark ? '#4bd08a' : '#1f9d55')
  const warn = color('yellow', 'color3') ?? (dark ? '#f0b23e' : '#c27c0e')
  const danger = color('red', 'color1') ?? (dark ? '#ff6b6b' : '#d23b3b')
  // The canvas around the panels is a step darker than them, in both modes, as in Tucano's own.
  const canvas = color('dark_background') ?? mix(bg, '#000000', dark ? 0.25 : 0.04)
  const text3 = mix(fg, bg, 0.45)
  const shadow = dark ? '0, 0, 0' : rgb(mix(fg, '#000000', 0.5)).join(', ')
  return {
    mode,
    background: canvas,
    vars: {
      '--bg': canvas,
      '--panel': bg,
      '--sidebar': canvas,
      '--hover': alpha(fg, 0.05),
      '--active': alpha(fg, 0.085),
      '--border': mix(bg, fg, dark ? 0.12 : 0.1),
      '--border-strong': mix(bg, fg, dark ? 0.2 : 0.17),
      '--text': fg,
      '--text-2': mix(fg, bg, 0.28),
      '--text-3': text3,
      '--select-caret': caret(text3),
      '--accent': accent,
      '--accent-soft': alpha(accent, 0.14),
      '--accent-text': readable(accent, bg, fg, '#ffffff', '#000000'),
      '--primary': fg,
      '--primary-text': bg,
      '--toast-bg': dark ? mix(bg, fg, 0.08) : bg,
      '--toast-ink': readable(dark ? mix(bg, fg, 0.08) : bg, accent, fg),
      '--bubble': mix(bg, fg, dark ? 0.08 : 0.05),
      '--ok': ok,
      '--ok-soft': alpha(ok, 0.13),
      '--warn': warn,
      '--warn-soft': alpha(warn, 0.14),
      '--danger': danger,
      '--danger-soft': alpha(danger, 0.12),
      '--code-bg': mix(bg, fg, dark ? 0.06 : 0.04),
      '--shadow': `0 1px 2px rgba(${shadow}, ${dark ? 0.35 : 0.05}), 0 ${dark ? '6px 20px' : '4px 16px'} rgba(${shadow}, ${dark ? 0.3 : 0.07})`,
      '--shadow-lg': `0 12px 40px rgba(${shadow}, ${dark ? 0.55 : 0.16})`,
      '--shadow-panel': `0 0 0 1px ${alpha(fg, dark ? 0.04 : 0.06)}, 0 ${dark ? '8px 30px' : '10px 30px'} rgba(${shadow}, ${dark ? 0.35 : 0.06})`
    }
  }
}

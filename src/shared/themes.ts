// Derived in OKLCH, so a lighter or darker step keeps its hue.
export const THEME_TOKENS = ['bg', 'panel', 'sidebar', 'hover', 'active', 'border', 'border-strong', 'text', 'text-2', 'text-3', 'accent', 'accent-soft', 'accent-text', 'primary', 'primary-text', 'toast-bg', 'toast-ink', 'bubble', 'ok', 'ok-soft', 'warn', 'warn-soft', 'danger', 'danger-soft', 'code-bg', 'selected', 'selected-ink', 'selected-ring', 'focus-ring'] as const
export type ThemeToken = (typeof THEME_TOKENS)[number]
export type ThemeTokens = Record<ThemeToken, string>
export type ColorScheme = 'light' | 'dark'

export interface ThemeSeeds {
  canvas: string
  accent: string
  ink?: string // unset: derived from the canvas
  tokens?: Partial<ThemeTokens> // win over what's derived
}

export interface Theme {
  id: string
  name: string
  light: ThemeSeeds
  dark: ThemeSeeds
}

export const AA_TEXT = 4.5
export const AA_LARGE = 3

const TUCANO_LIGHT: ThemeTokens = {
  bg: '#f3f0ea',
  panel: '#fffefb',
  sidebar: '#f3f0ea',
  hover: 'rgba(60, 40, 20, 0.05)',
  active: 'rgba(60, 40, 20, 0.085)',
  border: '#e8e3da',
  'border-strong': '#d9d2c6',
  text: '#1d1a16',
  'text-2': '#5f584e',
  'text-3': '#948b7f',
  accent: '#d9581a',
  'accent-soft': 'rgba(228, 99, 28, 0.12)',
  'accent-text': '#ffffff',
  primary: '#1d1a16',
  'primary-text': '#fffaf3',
  'toast-bg': '#fffefb',
  'toast-ink': '#b74d19',
  bubble: '#f1ece4',
  ok: '#1f9d55',
  'ok-soft': 'rgba(31, 157, 85, 0.12)',
  warn: '#c27c0e',
  'warn-soft': 'rgba(194, 124, 14, 0.13)',
  danger: '#d23b3b',
  'danger-soft': 'rgba(210, 59, 59, 0.1)',
  'code-bg': '#f3efe8',
  selected: '#fffefb',
  'selected-ink': '#1d1a16',
  'selected-ring': '#e8e3da',
  'focus-ring': '#d9d2c6'
}

const TUCANO_DARK: ThemeTokens = {
  bg: '#121110',
  panel: '#1a1917',
  sidebar: '#121110',
  hover: 'rgba(255, 240, 220, 0.05)',
  active: 'rgba(255, 240, 220, 0.085)',
  border: '#2a2825',
  'border-strong': '#3a3733',
  text: '#efeae2',
  'text-2': '#aaa39a',
  'text-3': '#7a746b',
  accent: '#ff8a3d',
  'accent-soft': 'rgba(255, 138, 61, 0.14)',
  'accent-text': '#1a1917',
  primary: '#f1ece4',
  'primary-text': '#1a1917',
  'toast-bg': '#2a2724',
  'toast-ink': '#ff8a3d',
  bubble: '#2a2724',
  ok: '#4bd08a',
  'ok-soft': 'rgba(75, 208, 138, 0.14)',
  warn: '#f0b23e',
  'warn-soft': 'rgba(240, 178, 62, 0.15)',
  danger: '#ff6b6b',
  'danger-soft': 'rgba(255, 107, 107, 0.13)',
  'code-bg': '#24221f',
  selected: '#1a1917',
  'selected-ink': '#efeae2',
  'selected-ring': '#2a2825',
  'focus-ring': '#3a3733'
}

export const DEFAULT_THEME_ID = 'tucano'

// The names are places and things of Brazil: the same in both languages.
export const THEMES: readonly Theme[] = [
  {
    id: DEFAULT_THEME_ID,
    name: 'Tucano',
    light: { canvas: TUCANO_LIGHT.bg, accent: TUCANO_LIGHT.accent, ink: TUCANO_LIGHT.text, tokens: TUCANO_LIGHT },
    dark: { canvas: TUCANO_DARK.bg, accent: TUCANO_DARK.accent, ink: TUCANO_DARK.text, tokens: TUCANO_DARK }
  },
  { id: 'sertao', name: 'Sertão', light: { canvas: '#f5eedf', accent: '#926a01' }, dark: { canvas: '#15110a', accent: '#e7b140' } },
  { id: 'cerrado', name: 'Cerrado', light: { canvas: '#f0f0e3', accent: '#5e6b10' }, dark: { canvas: '#11120b', accent: '#b6c95e' } },
  { id: 'mata', name: 'Mata Atlântica', light: { canvas: '#ecf2ec', accent: '#127946' }, dark: { canvas: '#0d1410', accent: '#50d188' } },
  { id: 'lencois', name: 'Lençóis', light: { canvas: '#f7f6f1', accent: '#067976' }, dark: { canvas: '#0a1415', accent: '#3bd7d2' } },
  { id: 'rio-negro', name: 'Rio Negro', light: { canvas: '#ecf0f4', accent: '#066b9a' }, dark: { canvas: '#0c1118', accent: '#4ab2ef' } },
  { id: 'pantanal', name: 'Pantanal', light: { canvas: '#eeeff7', accent: '#4d45bb' }, dark: { canvas: '#0f0f19', accent: '#9398ff' } },
  { id: 'acai', name: 'Açaí', light: { canvas: '#f3eef5', accent: '#7f3395' }, dark: { canvas: '#150f18', accent: '#d28ae8' } },
  { id: 'ipe', name: 'Ipê', light: { canvas: '#f8eff1', accent: '#bf3469' }, dark: { canvas: '#170f12', accent: '#ff90b0' } }
]
export const THEME_IDS = THEMES.map((t) => t.id)

// A cleared theme (null), or anything not a string, is Tucano's.
export const themeIdOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export const themeById = (id: string | undefined): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0]!

export const colorSchemeOf = (mode: 'system' | 'light' | 'dark', systemDark: boolean): ColorScheme =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

interface Oklch { l: number; c: number; h: number }
type Rgb = [number, number, number]

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

function rgbOf(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as Rgb
}

function hexOf(rgb: Rgb): string {
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

function oklabOf(hex: string): Rgb {
  const [r, g, b] = rgbOf(hex).map(toLinear) as Rgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function linearOfOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

const hexOfOklab = (lab: Rgb): string => hexOf(linearOfOklab(lab).map((v) => toGamma(Math.min(1, Math.max(0, v)))) as Rgb)

function oklchOf(hex: string): Oklch {
  const [l, a, b] = oklabOf(hex)
  return { l, c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI }
}

export const hueOf = (hex: string): number => (oklchOf(hex).h + 360) % 360

const labOfOklch = ({ l, c, h }: Oklch): Rgb => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]
const inGamut = (lab: Rgb): boolean => linearOfOklab(lab).every((v) => v >= -1e-4 && v <= 1 + 1e-4)

// Out of sRGB, the chroma gives way and the lightness and hue stay.
function hexOfOklch(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l))
  if (inGamut(labOfOklch({ ...color, l }))) return hexOfOklab(labOfOklch({ ...color, l }))
  let [low, high] = [0, color.c]
  for (let i = 0; i < 24; i++) {
    const c = (low + high) / 2
    if (inGamut(labOfOklch({ l, c, h: color.h }))) low = c
    else high = c
  }
  return hexOfOklab(labOfOklch({ l, c: low, h: color.h }))
}

export function mix(from: string, to: string, amount: number): string {
  const [a, b] = [oklabOf(from), oklabOf(to)]
  return hexOfOklab(a.map((v, i) => v + (b[i]! - v) * amount) as Rgb)
}

function shift(hex: string, lightness: number, chromaScale = 1): string {
  const c = oklchOf(hex)
  return hexOfOklch({ l: c.l + lightness, c: c.c * chromaScale, h: c.h })
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgbOf(hex).map((v) => Math.round(v * 255))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const luminance = (hex: string): number => {
  const [r, g, b] = rgbOf(hex).map(toLinear) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

export function readable(hex: string, backgrounds: string[], min: number): string {
  const darker = backgrounds.reduce((sum, bg) => sum + oklchOf(bg).l, 0) / backgrounds.length > 0.6
  const start = oklchOf(hex)
  let out = hex
  for (let step = 0; step <= 100 && backgrounds.some((bg) => contrast(out, bg) < min); step++)
    out = hexOfOklch({ ...start, l: start.l + (darker ? -step : step) * 0.01 })
  return out
}

function derived(seeds: ThemeSeeds, scheme: ColorScheme): ThemeTokens {
  const light = scheme === 'light'
  const status = light ? TUCANO_LIGHT : TUCANO_DARK
  const canvas = seeds.canvas
  const panel = light ? shift(canvas, 0.04, 0.4) : shift(canvas, 0.035)
  const accentText = light ? '#ffffff' : panel
  const accent = readable(seeds.accent, [accentText], AA_TEXT)
  const sidebar = mix(canvas, accent, light ? 0.05 : 0.06)
  const bubble = mix(panel, accent, light ? 0.08 : 0.13)
  const selected = mix(panel, accent, light ? 0.1 : 0.17)
  const canvasHue = oklchOf(canvas)
  const surfaces = [canvas, sidebar, panel]
  const ink = readable(seeds.ink ?? hexOfOklch({ l: light ? 0.22 : 0.94, c: Math.min(canvasHue.c, 0.012), h: canvasHue.h }), [...surfaces, bubble, selected], AA_TEXT)
  const raised = light ? panel : mix(panel, ink, 0.09)
  const borderStrong = mix(canvas, ink, light ? 0.13 : 0.21)
  return {
    ...status,
    bg: canvas,
    panel,
    sidebar,
    hover: rgba(ink, 0.05),
    active: rgba(ink, 0.085),
    border: mix(canvas, ink, light ? 0.055 : 0.13),
    'border-strong': borderStrong,
    text: ink,
    'text-2': readable(mix(ink, canvas, light ? 0.4 : 0.32), surfaces, AA_TEXT),
    'text-3': readable(mix(ink, canvas, light ? 0.58 : 0.52), surfaces, AA_LARGE),
    accent,
    'accent-soft': rgba(accent, light ? 0.12 : 0.14),
    'accent-text': accentText,
    primary: ink,
    'primary-text': panel,
    'toast-bg': raised,
    'toast-ink': readable(light ? mix(accent, ink, 0.15) : accent, [raised], AA_TEXT),
    bubble,
    'code-bg': light ? mix(canvas, ink, 0.01) : mix(panel, ink, 0.055),
    selected,
    'selected-ink': readable(mix(accent, ink, light ? 0.3 : 0.35), [selected], AA_TEXT),
    'selected-ring': mix(sidebar, accent, light ? 0.3 : 0.35),
    'focus-ring': mix(borderStrong, accent, 0.55)
  }
}

export function themeTokens(theme: Theme, scheme: ColorScheme): ThemeTokens {
  const seeds = theme[scheme]
  return { ...derived(seeds, scheme), ...seeds.tokens }
}

const selectCaret = (stroke: string): string =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${stroke.replace('#', '%23')}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`

export function themeVariables(theme: Theme, scheme: ColorScheme): Record<string, string> {
  const tokens = themeTokens(theme, scheme)
  return { ...Object.fromEntries(THEME_TOKENS.map((t) => [`--${t}`, tokens[t]])), '--select-caret': selectCaret(tokens['text-3']) }
}

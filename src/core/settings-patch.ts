// What a settings change may carry: the settings there are, each of its kind and within a size.
// Anything else is refused at once: what's saved goes in every snapshot, to everyone.
import { L } from '../shared/lang'
import type { Settings } from '../shared/types'

type Kind = 'string' | 'boolean' | 'number' | 'object' | 'array' | readonly string[]
// key → its kind, the most it takes (characters of its JSON), and whether null clears it.
const RULES: Partial<Record<keyof Settings, { kind: Kind; max: number; nullable?: boolean }>> = {
  workspaceName: { kind: 'string', max: 500 },
  workspaceLabel: { kind: 'string', max: 500, nullable: true },
  context: { kind: 'string', max: 100_000 },
  routerModel: { kind: 'string', max: 200 },
  memoryModel: { kind: 'string', max: 200 },
  voice: { kind: 'object', max: 10_000, nullable: true },
  channelLayout: { kind: 'object', max: 500_000, nullable: true },
  browserJev: { kind: 'boolean', max: 10, nullable: true },
  jevRecommend: { kind: 'boolean', max: 10, nullable: true },
  memoryLearning: { kind: ['approve', 'auto', 'off'], max: 20 },
  wikiCapture: { kind: 'boolean', max: 10, nullable: true },
  wikiEdits: { kind: ['approve', 'auto'], max: 20, nullable: true },
  wikiReview: { kind: ['weekly', 'off'], max: 20, nullable: true },
  wikiDir: { kind: 'string', max: 4_096, nullable: true },
  defaultLimit: { kind: 'number', max: 30 },
  approvalTtlHours: { kind: 'number', max: 30 },
  questionDeadlineHours: { kind: 'number', max: 30, nullable: true },
  theme: { kind: ['system', 'light', 'dark'], max: 20 },
  language: { kind: ['pt', 'en'], max: 10 },
  openAtLogin: { kind: 'boolean', max: 10, nullable: true },
  runBudgetPct: { kind: 'number', max: 30, nullable: true },
  runStallMinutes: { kind: 'number', max: 30, nullable: true },
  chainDepth: { kind: 'number', max: 30, nullable: true },
  actionRules: { kind: 'object', max: 2_000, nullable: true },
  autonomy: { kind: ['careful', 'normal', 'free'], max: 20, nullable: true },
  outsideGuard: { kind: 'boolean', max: 10, nullable: true },
  paused: { kind: 'boolean', max: 10, nullable: true },
  quietHours: { kind: 'object', max: 200, nullable: true },
  harnesses: { kind: 'array', max: 1_000, nullable: true },
  onboarding: { kind: 'object', max: 2_000, nullable: true },
  folded: { kind: 'array', max: 200_000, nullable: true },
  sounds: { kind: 'boolean', max: 10, nullable: true },
  seenVersion: { kind: 'string', max: 100, nullable: true }
}

const fits = (kind: Kind, v: unknown): boolean =>
  typeof kind !== 'string'
    ? typeof v === 'string' && kind.includes(v)
    : kind === 'array'
      ? Array.isArray(v)
      : kind === 'object'
        ? !!v && typeof v === 'object' && !Array.isArray(v)
        : kind === 'number'
          ? typeof v === 'number' && Number.isFinite(v) && v >= 0
          : typeof v === kind

// Why a patch is refused, or undefined when every key is one there is, of its kind, within its size.
export function settingsPatchError(patch: Record<string, unknown>): string | undefined {
  for (const [key, v] of Object.entries(patch)) {
    const rule = Object.hasOwn(RULES, key) ? RULES[key as keyof Settings] : undefined
    // Plain, without the key: one called "quota" would read as a plan at its limit (see errors.ts).
    if (!rule) return L('Essa configuração não existe.', "That setting doesn't exist.")
    if (v === undefined || (v === null && rule.nullable)) continue
    if (!fits(rule.kind, v)) return L(`Valor inválido pra ${key}.`, `Invalid value for ${key}.`)
    if (JSON.stringify(v).length > rule.max) return L(`Valor grande demais pra ${key}.`, `Value too big for ${key}.`)
  }
  return undefined
}

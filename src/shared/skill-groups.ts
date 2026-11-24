// How the skill library is grouped in the screens: by the folder it lives in on disk, which is how
// the library is organised already (`.../hermes/skills/foundry/foundry-macros/SKILL.md` is a foundry
// skill). A skill written in the app has no file, and one placed one level under a harness's own
// skills folder has no category: those group by where they came from.

export const SKILL_LOCAL = 'local'

// Where a linked skill came from, for the tag the screens show: Codex, Claude Code, or Hermes.
export function skillOrigin(source: string | undefined): 'codex' | 'claude' | 'hermes' | undefined {
  if (!source) return undefined
  const path = source.replace(/\\/g, '/') // on Windows the stored path has backslashes
  if (path.includes('/.codex/')) return 'codex'
  if (path.includes('/.claude/')) return 'claude'
  if (path.includes('/hermes/') || path.includes('/.hermes/')) return 'hermes'
  return undefined
}

export function skillGroup(source: string | undefined): string {
  if (!source) return SKILL_LOCAL
  const parts = source.replace(/\\/g, '/').split('/').filter(Boolean)
  // skills/<category>/<name>/SKILL.md: the category is two levels above the file.
  const category = parts.length >= 3 ? parts[parts.length - 3]! : ''
  if (!category || category === 'skills' || category === 'skill.md') return skillOrigin(source) ?? SKILL_LOCAL
  return category
}

// Source labels cover every harness read by local-skills, not only the three icon variants.
const HARNESSES: readonly [string, string][] = [
  ['/.hermes/', 'Hermes'], ['/hermes/', 'Hermes'],
  ['/.config/opencode/', 'OpenCode'], ['/.opencode/', 'OpenCode'],
  ['/.copilot/', 'Copilot'], ['/.gemini/', 'Gemini'], ['/.codex/', 'Codex'],
  ['/.pi/', 'Pi'], ['/.agents/', 'Agents'], ['/.claude/', 'Claude Code']
]
export function skillHarnessName(source: string | undefined): string | undefined {
  const path = source?.replaceAll('\\', '/').toLowerCase()
  return path ? HARNESSES.find(([folder]) => path.includes(folder))?.[1] : undefined
}

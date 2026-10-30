import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/types'
import { Db } from '../src/core/db'
import { findLocalSkills, frontmatter, readLinked } from '../src/core/local-skills'
import { Skills } from '../src/core/skills'

const agent = (id: string, handle: string): Agent => ({
  id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false
})
const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ad-home-'))
  put(join(home, '.claude/skills/video/SKILL.md'), '---\nname: video\ndescription: |\n  Cria os vídeos do canal.\n  Use pra "novo vídeo".\n---\n# Vídeos\nLeia estilo.md antes.')
  put(join(home, '.claude/skills/video/estilo.md'), 'Quadro de marcador.')
  put(join(home, '.claude/skills/video/motor/build.py'), 'print(1)')
  put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'sdd@mkt': true, 'root@mkt': true, 'off@mkt': false }, hooks: { Stop: [] } }))
  put(join(home, '.claude/plugins/cache/mkt/sdd/1.0.0/skills/verify/SKILL.md'), '---\nname: verify\ndescription: "Confere a entrega"\n---\nPassos.')
  put(join(home, '.claude/plugins/cache/mkt/off/1.0.0/skills/hidden/SKILL.md'), '---\nname: hidden\n---\n')
  // A plugin whose skill is the root itself, as "skills": ["./"] declares in the manifest.
  put(join(home, '.claude/plugins/cache/mkt/root/1.0.0/SKILL.md'), '---\nname: humanize\ndescription: "Remove AI tells"\n---\nReceita.')
  put(join(home, '.claude/plugins/cache/mkt/root/1.0.0/.claude-plugin/plugin.json'), JSON.stringify({ name: 'root', version: '1.0.0', skills: ['./'] }))
  put(join(home, '.codex/skills/imediato/SKILL.md'), '---\nname: imediato\ndescription: Responde já\n---\nCorpo.')
  put(join(home, 'secret.md'), 'segredo')
  symlinkSync(join(home, 'secret.md'), join(home, '.claude/skills/video/fuga.md'))
})

describe('local skills', () => {
  it('reads name and description, including a "|" block', () => {
    expect(frontmatter('---\nname: a\ndescription: |\n  um\n  dois\nlicense: MIT\n---\ncorpo')).toEqual({ name: 'a', description: 'um dois', body: 'corpo' })
  })

  it("finds the user's Claude Code skills, the turned-on plugins' and Codex's, with their files and scripts", () => {
    const found = findLocalSkills(home)
    expect(found.map((k) => [k.name, k.origin])).toEqual([['video', 'Claude Code'], ['verify', 'Plugin sdd'], ['humanize', 'Plugin root'], ['imediato', 'Codex']])
    const video = found[0]!
    expect(video.description).toBe('Cria os vídeos do canal. Use pra "novo vídeo".')
    expect(video.files).toEqual(['estilo.md', 'fuga.md'])
    expect(video.scripts).toBe(true)
  })

  it('finds a skill whose folder is a symlink, as the skills CLI leaves it, and skips a broken one', () => {
    put(join(home, '.agents/skills/grill-me/SKILL.md'), '---\nname: grill-me\ndescription: Entrevista sem piedade\n---\nChame grilling.')
    symlinkSync(join(home, '.agents/skills/grill-me'), join(home, '.claude/skills/grill-me'))
    symlinkSync(join(home, '.agents/skills/gone'), join(home, '.claude/skills/gone'), 'dir')
    const found = findLocalSkills(home)
    expect(found.filter((k) => k.origin === 'Claude Code').map((k) => k.name).sort()).toEqual(['grill-me', 'video'])
    expect(found.find((k) => k.name === 'grill-me')?.source).toBe(join(home, '.claude/skills/grill-me/SKILL.md'))
  })

  it('reads a linked file only inside the skill folder, following links', () => {
    const source = join(home, '.claude/skills/video/SKILL.md')
    expect(readLinked(source)).toBe('# Vídeos\nLeia estilo.md antes.')
    expect(readLinked(source, 'estilo.md')).toBe('Quadro de marcador.')
    expect(() => readLinked(source, '../../settings.json')).toThrow('não é da skill')
    expect(() => readLinked(source, 'fuga.md')).toThrow('não é da skill')
    expect(() => readLinked(source, 'motor/build.py')).toThrow('texto')
  })

  it('an agent reads a linked skill from the file as it is now, and its support files; it cannot propose changes to it', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-ls-')), 'test.db'))
    const skills = new Skills({ db, emit: () => {} })
    const a = agent('a1', 'lia')
    db.saveAgent(a)
    const source = join(home, '.claude/skills/video/SKILL.md')
    const k = skills.link(source, [])
    expect(k).toMatchObject({ name: 'video', source, state: 'active' })
    put(source, '---\nname: video\ndescription: x\n---\nReceita nova.')
    const r = skills.read(a, { nome: 'video' })
    expect(r.reply).toContain('Receita nova.')
    expect(r.reply).toContain('Arquivos de apoio desta skill')
    expect(skills.read(a, { nome: 'video', arquivo: 'estilo.md' }).reply).toContain('Quadro de marcador.')
    expect(skills.propose(a, { nome: 'video', quando_usar: 'x', receita: 'y' })).toMatchObject({ error: true })
    expect(skills.save({ id: k.id, name: 'outro', description: '', body: '', agents: ['a1'] })).toMatchObject({ name: 'video', agents: ['a1'], source })
  })
})

// One turned-on plugin, laid out as each case needs, following Claude Code's manifest rules.
describe('plugin skills declared in the manifest', () => {
  const plugin = (manifest: object | null, files: Record<string, string>): string => {
    const root = join(home, '.claude/plugins/cache/mkt/p/1.0.0')
    put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'p@mkt': true } }))
    if (manifest) put(join(root, '.claude-plugin/plugin.json'), JSON.stringify(manifest))
    for (const [file, text] of Object.entries(files)) put(join(root, file), text)
    return root
  }
  const names = (): string[] => findLocalSkills(home).filter((k) => k.origin === 'Plugin p').map((k) => k.name).sort()

  it('adds the declared folders to the skills/ scan', () => {
    plugin({ name: 'p', skills: ['./extra/'] }, { 'skills/a/SKILL.md': '---\nname: a\n---\n', 'extra/b/SKILL.md': '---\nname: b\n---\n' })
    expect(names()).toEqual(['a', 'b'])
  })

  it('takes a single path as well as a list', () => {
    plugin({ name: 'p', skills: './' }, { 'SKILL.md': '---\nname: root\n---\n' })
    expect(names()).toEqual(['root'])
  })

  it('reads a root SKILL.md as the skill when there is no skills/ and no manifest', () => {
    plugin(null, { 'SKILL.md': '---\nname: root\n---\n' })
    expect(names()).toEqual(['root'])
  })

  it('ignores a declared path that leaves the plugin', () => {
    plugin({ name: 'p', skills: ['../../../../../../'] }, {})
    put(join(home, 'SKILL.md'), '---\nname: fora\n---\n')
    expect(names()).toEqual([])
  })
})

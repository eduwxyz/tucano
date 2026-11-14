// #242: what a *model* reads must not be Portuguese-only in an English workspace.
//
// The app writes text twice, side by side (L('Salvar', 'Save')), so a string that goes through L() is
// correct in both. What this test catches is the other kind: text a model reads that has no second
// language at all (a Portuguese id in a link it is taught to write, a Portuguese page title in the
// index it carries on every message), and a Portuguese word that slipped into an English description.
//
// The guide's pages are written twice, Portuguese and English (src/core/guide/ and
// src/core/guide/en/), so in an English workspace both the index and the page a model reads are
// English, and the check below reads the bodies the same way it reads the index.
//
// Deliberately out of scope, so nobody thinks this covers everything: the tool argument names the
// agents must emit are Portuguese (habilitado, pedido, dias…), which is a real leak of the same
// family and not a string this test can fix by itself.
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { SCREEN_ALIASES, SCREENS } from '../src/shared/screens'
import { GUIDE, LER_GUIA, guideHead, guideIndex, readGuide } from '../src/core/guide'
import { PROPOR_AGENTE, PROPOR_TIME, helperSection, tucaInstructions } from '../src/core/tuca'
import { PROPOR_AJUSTE, PROPOR_CANAL, PROPOR_ROTINA, VER_ESTADO } from '../src/core/tuca-help'
import { LER_SKILL, PROPOR_SKILL } from '../src/core/skills'
import type { ToolDef } from '../src/core/gateway'

// Words that are Portuguese and not English, distinctive enough not to hit a real English sentence.
// Word-bounded, so "para" inside "paragraph" and "com" inside ".com" are left alone — "com" is not in
// the list for exactly that reason.
const PT =
  /\b(não|você|também|já|até|para|uma|dos|das|nas|pelo|pela|só|mais|quando|quem|onde|cada|todo|toda|tudo|agente|agentes|motores|conectores|rotinas|falhas|aprovação|aprovações|aprovacao|aprovacoes|configuração|configurações|configuracoes|memória|memória|memorias|boletim|página|páginas|pagina|paginas|segure|receita|rotina|limite|limites|resposta|respostas|conversa|conversas|mensagem|mensagens|nunca|sempre|depois|antes|agora|aqui|este|esta|isso|esse|essa|nela|nele|dele|dela|serve|pode|faz|feito|hoje|ontem|amanhã|amanha|horário|horario|árvore|silêncio|silencio|pare|tente|abrir|fechar|salvar|apagar|criar|editar|vocês|voces|também|então|entao|porque|sobre|entre|sem|com o|para o)\b/iu

// "#abrir/" is a URL fragment every link already written carries, not vocabulary: the words the
// model is taught are the ids after it. Stripped here, and named in the PR as the one Portuguese
// piece left in a link.
const nominal = (text: string): string => text.replace(/#abrir\//g, '#')

// A page's file name is a slug, not vocabulary: an English page still says "see **aprovacoes**"
// because that is what ler_guia takes. The slugs come out before a body is read for Portuguese, the
// same way the index's own lines are skipped above.
const SLUGS = /\b(agentes|aprovacoes|backup|celular|comecar|composio|computadores|conectores|conversas|google|limites|memoria|motores|organograma|problemas|rede|rotinas|servidor|skills|slack|time|wiki-git|wiki|workspaces)\b/gi
// A command inside backticks is a name, not prose either: `tailscale serve` is a flag, not the
// Portuguese "serve".
const withoutSlugs = (text: string): string => nominal(text).replace(SLUGS, '').replace(/`[^`]*`/g, '')

const leak = (label: string, text: string): void => {
  const m = PT.exec(nominal(text))
  if (m) throw new Error(`${label}: "…${text.slice(Math.max(0, m.index - 40), m.index + 40)}…" (${m[0]})`)
}

// The prose of a tool: what the model reads to decide to call it. Not the argument names — see the
// note at the top.
const prose = (t: ToolDef): string => {
  const schema = JSON.stringify(t.inputSchema)
  const described = [...schema.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\"/g, '"'))
  return [t.description, ...described].join('\n')
}

const TOOLS: ToolDef[] = [VER_ESTADO, PROPOR_AJUSTE, PROPOR_ROTINA, PROPOR_CANAL, PROPOR_AGENTE, PROPOR_TIME, LER_GUIA, LER_SKILL, PROPOR_SKILL]

afterEach(() => setLang('pt'))

describe('an English workspace, and what a model reads in it', () => {
  it('teaches language-free screen ids: the Portuguese ones stay as aliases, not in the prompt', () => {
    setLang('en')
    const slugs = Object.keys(SCREENS)
    for (const slug of slugs) leak(`screen id "${slug}"`, slug)
    // the aliases are Portuguese on purpose, and none of them is a screen of its own
    for (const [alias, canonical] of Object.entries(SCREEN_ALIASES)) expect(slugs).toContain(canonical)
    expect(Object.keys(SCREEN_ALIASES).filter((a) => slugs.includes(a))).toEqual([])

    // Every line of the Tuca's prompt that isn't the guide index (those carry a Portuguese file slug),
    // and the whole screens block, is English.
    const lines = helperSection().split('\n').filter((l) => !/^- [a-z-]+: /.test(l))
    leak("the Tuca's prompt", lines.join('\n'))
  })

  it("gives the Tuca's guide in English, index and pages alike", () => {
    setLang('en')
    expect(GUIDE.filter((p) => !p.en)).toEqual([]) // every page has its English twin
    for (const p of GUIDE) {
      const h = guideHead(p)
      leak(`guide index "${p.slug}"`, `${h.title}. ${h.summary}`)
      expect(h.title.trim()).not.toBe('')
      expect(h.summary.trim()).not.toBe('')
      // The page a model reads is English too: a Portuguese body in an English workspace is the leak
      // this whole test is about, and the one a model copies labels out of.
      leak(`guide page "${p.slug}" (English)`, withoutSlugs(readGuide(p.slug).text))
    }
    const index = guideIndex()
    expect(index).toContain('- agentes: Agents. ')
    expect(index).not.toContain('written in Portuguese')
    expect(readGuide('agentes').text.split('\n')[0]).toBe('# Agents')
    expect(readGuide('nope').text).toContain("There's no such page")
  })

  it('keeps the Portuguese side when the workspace is Portuguese', () => {
    setLang('pt')
    const index = guideIndex()
    expect(index).toContain('- agentes: Agentes. ')
    expect(index).not.toContain("The body of a guide page")
    expect(readGuide('agentes').text.split('\n')[0]).toBe('# Agentes')
    expect(readGuide('nope').text).toContain('Não existe essa página')
  })

  it("writes the prose of the app's tools in the language the workspace is in", () => {
    setLang('en')
    for (const t of TOOLS) leak(`tool "${t.name}"`, prose(t))
    // ver_estado's areas are a closed list the model has to type: English now, Portuguese accepted.
    leak('ver_estado areas', JSON.stringify(VER_ESTADO.inputSchema))
    expect(JSON.stringify(VER_ESTADO.inputSchema)).toContain('"harnesses"')
  })

  it("writes the Tuca's own instructions in the language the workspace is in", () => {
    setLang('en')
    leak("the Tuca's instructions", tucaInstructions())
    expect(tucaInstructions()).toMatch(/Tucano/)
  })
})

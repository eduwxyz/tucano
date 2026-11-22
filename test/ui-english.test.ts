// "If the person picks English, everything on the screen is English." The app writes what a person
// reads twice, side by side (L('Salvar', 'Save')), so the leaks are of two kinds, and this reads the
// source for both:
//   1. an English side that is still Portuguese: L('Cofre', 'Cofre') shipped the Vault as "Cofre";
//   2. Portuguese with no English at all: a JSX text, a placeholder, a label left out of L().
// Only the screen's code (renderer, main, shared, preload): what the core writes for the models
// (prompts, tool descriptions) is a separate pass, see model-facing-language.test.ts.
//
// No parser in the dependencies, so a small tokenizer: strings, templates (with their ${}), comments,
// regex literals and brackets are all it needs to find each L( and its two arguments.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const DIRS = ['src/renderer/src', 'src/main', 'src/shared', 'src/preload']

type Tok = { k: 'str'; text: string; pos: number; parts?: Tok[][] } | { k: 'id'; text: string; pos: number } | { k: 'p'; text: string; pos: number }

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do'])

// Tokenizes from `i` until an unmatched `}` (inside a template's ${}) or the end.
function tokenize(src: string, start: number, inTemplate: boolean): { toks: Tok[]; end: number } {
  const toks: Tok[] = []
  let i = start
  let depth = 0
  const prevSignificant = (): Tok | undefined => toks[toks.length - 1]
  while (i < src.length) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? src.length : e + 2
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let text = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') (text += src[j + 1] ?? ''), (j += 2)
        else text += src[j++]
      }
      toks.push({ k: 'str', text, pos: i })
      i = j + 1
      continue
    }
    if (c === '`') {
      const parts: Tok[][] = []
      let text = ''
      let j = i + 1
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') (text += src[j + 1] ?? ''), (j += 2)
        else if (src[j] === '$' && src[j + 1] === '{') {
          const inner = tokenize(src, j + 2, true)
          parts.push(inner.toks)
          text += '${}'
          j = inner.end + 1
        } else text += src[j++]
      }
      toks.push({ k: 'str', text, pos: i, parts })
      i = j + 1
      continue
    }
    if (c === '/') {
      const p = prevSignificant()
      const regex = !p || (p.k === 'p' && REGEX_BEFORE.has(p.text)) || (p.k === 'id' && REGEX_AFTER_WORD.has(p.text))
      if (regex) {
        let j = i + 1
        let cls = false
        while (j < src.length && (cls || src[j] !== '/') && src[j] !== '\n') {
          if (src[j] === '\\') j++
          else if (src[j] === '[') cls = true
          else if (src[j] === ']') cls = false
          j++
        }
        j++
        while (/[a-z]/i.test(src[j] ?? '')) j++
        i = j
        toks.push({ k: 'id', text: 'REGEX', pos: i })
        continue
      }
    }
    if (/[\w$]/.test(c)) {
      let j = i
      while (j < src.length && /[\w$]/.test(src[j]!)) j++
      toks.push({ k: 'id', text: src.slice(i, j), pos: i })
      i = j
      continue
    }
    if (c === '{') depth++
    if (c === '}') {
      if (inTemplate && depth === 0) return { toks, end: i }
      depth--
    }
    toks.push({ k: 'p', text: c, pos: i })
    i++
  }
  return { toks, end: i }
}

// Every L(pt, en) in a token list, nested ones included: its two arguments' tokens.
function lCalls(toks: Tok[], out: { pt: Tok[]; en: Tok[] }[] = []): { pt: Tok[]; en: Tok[] }[] {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.k === 'str') for (const part of t.parts ?? []) lCalls(part, out)
    if (!(t.k === 'id' && t.text === 'L' && toks[i + 1]?.text === '(' && toks[i - 1]?.text !== '.')) continue
    const args: Tok[][] = [[]]
    let depth = 0
    let j = i + 2
    for (; j < toks.length; j++) {
      const x = toks[j]!
      if (x.k === 'p' && '([{'.includes(x.text)) depth++
      if (x.k === 'p' && ')]}'.includes(x.text)) {
        if (depth === 0) break
        depth--
      }
      if (x.k === 'p' && x.text === ',' && depth === 0) args.push([])
      else args[args.length - 1]!.push(x)
    }
    if (args.length >= 2) out.push({ pt: args[0]!, en: args[1]! })
  }
  return out
}

// The text a list of tokens shows, nested L() calls left to their own check.
function shown(toks: Tok[]): string[] {
  const out: string[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.k === 'id' && t.text === 'L' && toks[i + 1]?.text === '(') {
      // skip the nested call's arguments
      let depth = 0
      for (i += 1; i < toks.length; i++) {
        if (toks[i]!.text === '(') depth++
        if (toks[i]!.text === ')' && --depth === 0) break
      }
      continue
    }
    if (t.k === 'str') {
      out.push(t.text)
      for (const part of t.parts ?? []) out.push(...shown(part))
    }
  }
  return out
}

// Portuguese and not English: its letters, the app's own Portuguese names, and words no English
// sentence has. Tool names (buscar_memorias) and 1Password references are identifiers, not copy.
const ACCENTS = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔ]/
const WORDS = /(?<![\p{L}_/.-])(Cofre|Quadro|Conhecimento|Operação|Boletim|Aprovações|Configurações|Conectores|Rotinas|Memória|Agentes|Canais|Pessoas|não|você|pra|uma|está|isso|esse|essa|também|então|agora|aqui|nenhum|nenhuma|Espaço)(?![\p{L}_])/u
const plain = (s: string): string => s.replace(/\b\w+_\w+\b/g, '').replace(/op:\/\/\S+/g, '').replace(/#abrir\/\S+/g, '')
const portuguese = (s: string): string | undefined => {
  const p = plain(s)
  return (WORDS.exec(p) ?? ACCENTS.exec(p))?.[0]
}
// "pt · en" in one string, for a page that can't know the language yet: the English is beside it.
const bilingual = (s: string): boolean => s.includes(' · ') && !portuguese(s.split(' · ').at(-1)!)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !f.endsWith('.d.ts') ? [p] : []
  })
}
// Helpers that take a pair the same way, the Portuguese then the English: model('sonnet', …, 'Bom pra maioria', 'Good for most things').
const PAIRS = new Set(['e', 'g', 'model', 'effort'])
// The browser's page script describes a page to the agent (model-facing, like the prompts).
const SKIP = new Set(['src/shared/page.ts'])

const SOURCES = DIRS.flatMap((d) => files(join(ROOT, d)))
  .map((path) => ({ path, rel: relative(ROOT, path).split('\\').join('/'), src: readFileSync(path, 'utf8') }))
  .filter((f) => !SKIP.has(f.rel))
// The (pt, en) string pairs of the pair helpers' calls.
function pairCalls(toks: Tok[]): { pt: Tok; en: Tok }[] {
  const out: { pt: Tok; en: Tok }[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (!(t.k === 'id' && PAIRS.has(t.text) && toks[i + 1]?.text === '(' && toks[i - 1]?.text !== '.')) continue
    const args: Tok[][] = [[]]
    let depth = 0
    for (let j = i + 2; j < toks.length; j++) {
      const x = toks[j]!
      if (x.k === 'p' && '([{'.includes(x.text)) depth++
      if (x.k === 'p' && ')]}'.includes(x.text) && depth-- === 0) break
      if (x.k === 'p' && x.text === ',' && depth === 0) args.push([])
      else args[args.length - 1]!.push(x)
    }
    for (let a = 0; a + 1 < args.length; a++) {
      const [p, n] = [args[a]!, args[a + 1]!]
      if (p.length === 1 && n.length === 1 && p[0]!.k === 'str' && n[0]!.k === 'str' && portuguese(p[0]!.text)) out.push({ pt: p[0]!, en: n[0]! })
    }
  }
  return out
}
const lineOf = (src: string, pos: number): number => src.slice(0, pos).split('\n').length

// Portuguese written outside L() on purpose: the language picker's own names, the pt half of a pair
// picked by the language (an array or an object with pt/en), and words matched, not shown.
const RAW_ALLOWED: Record<string, string[]> = {
  'src/renderer/src/components/Intro.tsx': ['Português', 'Idioma · Language'],
  'src/renderer/src/components/Pages.tsx': ['Português'],
  'src/renderer/src/components/Routines.tsx': ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'],
  'src/renderer/src/components/routines-view.ts': ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'],
  'src/shared/types.ts': ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'Todo domingo', 'Toda segunda', 'Toda terça', 'Toda quarta', 'Toda quinta', 'Toda sexta', 'Todo sábado'],
  // keys matched against a step's label, in both languages
  'src/renderer/src/components/Panel.tsx': ['Leu a página'],
  'src/renderer/src/components/Servers.tsx': ['Conectado: os agentes de lá podem usar este computador quando trabalham pra você.']
}

// The strings an L() call's first argument holds, wherever it is: the Portuguese side, fine as it is.
function ptSides(toks: Tok[]): Set<number> {
  const at = new Set<number>()
  const mark = (ts: Tok[]): void => {
    for (const t of ts) {
      if (t.k !== 'str') continue
      at.add(t.pos)
      for (const part of t.parts ?? []) mark(part)
    }
  }
  for (const c of lCalls(toks)) mark(c.pt)
  for (const c of pairCalls(toks)) at.add(c.pt.pos)
  return at
}

function allStrings(toks: Tok[], out: Tok[] = []): Tok[] {
  for (const t of toks) {
    if (t.k !== 'str') continue
    out.push(t)
    for (const part of t.parts ?? []) allStrings(part, out)
  }
  return out
}

describe('the screen in English', () => {
  it("writes every L() call's English side in English", () => {
    const leaks: string[] = []
    for (const f of SOURCES) {
      for (const call of lCalls(tokenize(f.src, 0, false).toks)) {
        for (const text of shown(call.en)) {
          const hit = portuguese(text)
          if (hit) leaks.push(`${f.rel}:${lineOf(f.src, call.en[0]?.pos ?? 0)} "${text.slice(0, 80)}" (${hit})`)
        }
      }
      for (const pair of pairCalls(tokenize(f.src, 0, false).toks)) {
        const hit = portuguese(pair.en.text)
        if (hit) leaks.push(`${f.rel}:${lineOf(f.src, pair.en.pos)} "${pair.en.text.slice(0, 80)}" (${hit})`)
      }
    }
    expect(leaks).toEqual([])
  })

  it('shows no Portuguese without its English beside it', () => {
    const leaks: string[] = []
    for (const f of SOURCES) {
      const toks = tokenize(f.src, 0, false).toks
      const pt = ptSides(toks)
      const allowed = RAW_ALLOWED[f.rel] ?? []
      for (const s of allStrings(toks)) {
        if (pt.has(s.pos) || allowed.includes(s.text) || bilingual(s.text) || !ACCENTS.test(plain(s.text))) continue
        leaks.push(`${f.rel}:${lineOf(f.src, s.pos)} "${s.text.slice(0, 80)}"`)
      }
      // JSX text: what sits between tags, outside any {}
      if (f.rel.endsWith('.tsx')) {
        const noComments = f.src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        for (const m of noComments.matchAll(/>([^<>{}]*[ãõçáéíóúâêôà][^<>{}]*)</giu)) {
          const text = m[1]!.trim()
          if (text && !allowed.includes(text) && !/[=;()]/.test(text)) leaks.push(`${f.rel}:${lineOf(noComments, m.index)} JSX "${text.slice(0, 80)}"`)
        }
      }
    }
    expect(leaks).toEqual([])
  })

  it('catches the leaks it is here for', () => {
    const calls = lCalls(tokenize("const a = L('Cofre', 'Cofre'); const b = L(`Abrir ${x}`, `Open ${L('o agente', 'the agent')}`)", 0, false).toks)
    expect(calls.flatMap((c) => shown(c.en)).map(portuguese)).toEqual(['Cofre', undefined, undefined])
    expect(portuguese('Agents find it with buscar_memorias.')).toBeUndefined()
    expect(portuguese('An op://Vault/Item/field value')).toBeUndefined()
    expect(portuguese('Nothing waits on você')).toBe('você')
  })
})

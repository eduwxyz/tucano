// The app's guide, which the Tuca reads to explain how Tucano works: a page per topic in
// src/core/guide/, each starting with "# Title" and a "> one-line summary". He sees the list in his
// prompt and reads a page with ler_guia before explaining it, so he doesn't make things up.
//
// Each page is written twice: the Portuguese one in src/core/guide/, the English one in
// src/core/guide/en/ with the same slug. A workspace in English reads the English page, one in
// Portuguese reads the Portuguese one, so a model never copies a label from the other language into
// an answer. test/guide.test.ts fails on a page that exists in one and not the other.
import type { ToolDef } from './gateway'
import { L, lang } from '../shared/lang'

const ptFiles = import.meta.glob<string>('./guide/*.md', { query: '?raw', import: 'default', eager: true })
const enFiles = import.meta.glob<string>('./guide/en/*.md', { query: '?raw', import: 'default', eager: true })

export interface GuideText {
  title: string
  summary: string
  body: string
}

export interface GuidePage extends GuideText {
  slug: string
  en?: GuideText
}

const parse = (path: string, text: string): { slug: string } & GuideText => {
  const [first = '', second = '', ...rest] = text.replace(/\r\n/g, '\n').split('\n')
  return {
    slug: path.replace(/^.*\//, '').replace(/\.md$/, ''),
    title: first.replace(/^#\s*/, '').trim(),
    summary: second.replace(/^>\s*/, '').trim(),
    body: rest.join('\n').trim()
  }
}

const english = new Map<string, GuideText>(
  Object.entries(enFiles).map(([path, text]) => {
    const page = parse(path, text)
    return [page.slug, { title: page.title, summary: page.summary, body: page.body }]
  })
)

export const GUIDE: GuidePage[] = Object.entries(ptFiles)
  .map(([path, text]) => {
    const page = parse(path, text)
    const en = english.get(page.slug)
    return { slug: page.slug, title: page.title, summary: page.summary, body: page.body, ...(en ? { en } : {}) }
  })
  .sort((a, b) => a.slug.localeCompare(b.slug))

// The page in the language the model reads: English in an English workspace, the page's own
// Portuguese in a Portuguese one.
const pageIn = (page: GuidePage): GuideText => (lang() === 'en' && page.en ? page.en : page)

export const guideHead = (page: GuidePage): { title: string; summary: string } => {
  const { title, summary } = pageIn(page)
  return { title, summary }
}

// The list in the Tuca's prompt: what each page covers.
export const guideIndex = (pages: GuidePage[] = GUIDE): string =>
  pages
    .map((p) => {
      const h = guideHead(p)
      return `- ${p.slug}: ${h.title}. ${h.summary}`
    })
    .join('\n')

export const LER_GUIA: ToolDef = {
  name: 'ler_guia',
  get description() {
    return L(
      'Lê uma página do guia do Tucano (a lista está no seu prompt). Leia antes de explicar como algo funciona, e explique só o que a página diz.',
      "Reads a page of Tucano's guide (the list is in your prompt). Read it before explaining how something works, explain only what the page says, and answer in the language the person is using."
    )
  },
  get inputSchema() {
    return { type: 'object' as const, properties: { pagina: { type: 'string', enum: GUIDE.map((p) => p.slug) } }, required: ['pagina'] }
  }
}

export function readGuide(slug: unknown, pages: GuidePage[] = GUIDE): { text: string; error?: boolean } {
  const page = pages.find((p) => p.slug === String(slug ?? '').trim().toLowerCase())
  if (!page) return { text: L(`Não existe essa página. As que existem: ${pages.map((p) => p.slug).join(', ')}.`, `There's no such page. The ones there are: ${pages.map((p) => p.slug).join(', ')}.`), error: true }
  // The heading and the body are both in the language it is asked for.
  const { title, body } = pageIn(page)
  return { text: `# ${title}\n\n${body}` }
}

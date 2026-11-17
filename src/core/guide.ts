// The app's guide, which the Tuca reads to explain how Tucano works: a page per topic in
// src/core/guide/, each starting with "# Title" and a "> one-line summary". He sees the list in
// his prompt and reads a page with ler_guia before explaining it, so he doesn't make things up.
import type { ToolDef } from './gateway'
import { L, lang } from '../shared/lang'
import { GUIDE_EN } from './guide-i18n'

const files = import.meta.glob<string>('./guide/*.md', { query: '?raw', import: 'default', eager: true })

export interface GuidePage {
  slug: string
  title: string
  summary: string
  body: string
}

export const GUIDE: GuidePage[] = Object.entries(files)
  .map(([path, text]) => {
    const [first = '', second = '', ...rest] = text.replace(/\r\n/g, '\n').split('\n')
    return { slug: path.replace(/^.*\//, '').replace(/\.md$/, ''), title: first.replace(/^#\s*/, '').trim(), summary: second.replace(/^>\s*/, '').trim(), body: rest.join('\n').trim() }
  })
  .sort((a, b) => a.slug.localeCompare(b.slug))

// The guide's bodies are Portuguese only, and in an English workspace a model that reads one copies
// its labels into the answer ("Configure Aprovações") unless it is told where that Portuguese comes
// from. The index a model sees on every message is in English (guide-i18n.ts), so this line is about
// the bodies alone; in a Portuguese workspace it would be telling the model what it can see, so it
// isn't there.
const GUIDE_LANGUAGE_NOTE =
  "The body of a guide page is written in Portuguese (they are the app's own manual). Explain what a page says in the language the person is writing in, and never copy its Portuguese labels into the answer."

// A page's title and summary in the language the model reads: English in an English workspace, the
// page's own Portuguese in a Portuguese one.
export const guideHead = (page: GuidePage): { title: string; summary: string } =>
  lang() === 'en' ? (GUIDE_EN[page.slug] ?? { title: page.title, summary: page.summary }) : { title: page.title, summary: page.summary }

// The list in the Tuca's prompt: what each page covers.
export const guideIndex = (pages: GuidePage[] = GUIDE): string =>
  [
    ...(lang() === 'pt' ? [] : [GUIDE_LANGUAGE_NOTE]),
    ...pages.map((p) => {
      const h = guideHead(p)
      return `- ${p.slug}: ${h.title}. ${h.summary}`
    })
  ].join('\n')

export const LER_GUIA: ToolDef = {
  name: 'ler_guia',
  get description() {
    return L(
      'Lê uma página do guia do Tucano (a lista está no seu prompt). Leia antes de explicar como algo funciona, e explique só o que a página diz.',
      "Reads a page of Tucano's guide (the list is in your prompt, and the pages are written in Portuguese). Read it before explaining how something works, explain only what the page says, and answer in the language the person is using."
    )
  },
  get inputSchema() {
    return { type: 'object' as const, properties: { pagina: { type: 'string', enum: GUIDE.map((p) => p.slug) } }, required: ['pagina'] }
  }
}

export function readGuide(slug: unknown, pages: GuidePage[] = GUIDE): { text: string; error?: boolean } {
  const page = pages.find((p) => p.slug === String(slug ?? '').trim().toLowerCase())
  if (!page) return { text: L(`Não existe essa página. As que existem: ${pages.map((p) => p.slug).join(', ')}.`, `There's no such page. The ones there are: ${pages.map((p) => p.slug).join(', ')}.`), error: true }
  // The heading is the page's title in the language it is asked for; the body under it is Portuguese.
  return { text: `# ${guideHead(page).title}\n\n${page.body}` }
}

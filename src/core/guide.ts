// The app's guide, which the Tuca reads to explain how Tucano works: a page per topic in
// src/core/guide/, each starting with "# Title" and a "> one-line summary". He sees the list in
// his prompt and reads a page with ler_guia before explaining it, so he doesn't make things up.
import type { ToolDef } from './gateway'
import { L } from '../shared/lang'

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

// The list in the Tuca's prompt: what each page covers.
export const guideIndex = (pages: GuidePage[] = GUIDE): string => pages.map((p) => `- ${p.slug}: ${p.title}. ${p.summary}`).join('\n')

export const LER_GUIA: ToolDef = {
  name: 'ler_guia',
  get description() {
    return L(
      'Lê uma página do guia do Tucano (a lista está no seu prompt). Leia antes de explicar como algo funciona, e explique só o que a página diz.',
      "Reads a page of Tucano's guide (the list is in your prompt). Read it before explaining how something works, and explain only what the page says."
    )
  },
  get inputSchema() {
    return { type: 'object' as const, properties: { pagina: { type: 'string', enum: GUIDE.map((p) => p.slug) } }, required: ['pagina'] }
  }
}

export function readGuide(slug: unknown, pages: GuidePage[] = GUIDE): { text: string; error?: boolean } {
  const page = pages.find((p) => p.slug === String(slug ?? '').trim().toLowerCase())
  if (!page) return { text: L(`Não existe essa página. As que existem: ${pages.map((p) => p.slug).join(', ')}.`, `There's no such page. The ones there are: ${pages.map((p) => p.slug).join(', ')}.`), error: true }
  return { text: `# ${page.title}\n\n${page.body}` }
}

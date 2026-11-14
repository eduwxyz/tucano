// The wiki's review finds two kinds of nothing-to-do-with-me: a page the wiki links to that
// doesn't exist, and a page nothing links to. Neither is written by a person typing it: the
// finding's card offers an agent, and that agent gets one message with what it needs to do the
// job (the titles, the pages around them, the lines that mention them). The text is built here,
// away from the window, so it can be tested and so the app says the same thing every time.
import { L } from '../shared/lang'
import type { WikiFinding, WikiPage } from '../shared/types'

// The findings an agent can take: the two that add a page, and the one that adds the links.
export const HAND_OFF_KINDS: readonly WikiFinding['kind'][] = ['broken', 'missing', 'orphan']
export const canHandOff = (kind: WikiFinding['kind']): boolean => HAND_OFF_KINDS.includes(kind)

const LINE_CHARS = 300
const LINES_PER_PAGE = 3

const clip = (s: string): string => {
  const line = s.trim()
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line
}

// The lines of a page that carry a name or a link to it: what the agent has to go on.
function linesOf(page: WikiPage, needles: string[]): string[] {
  const out: string[] = []
  for (const line of page.body.split('\n')) {
    const plain = line.toLowerCase()
    if (needles.some((n) => plain.includes(n.toLowerCase())) && line.trim()) out.push(clip(line))
    if (out.length >= LINES_PER_PAGE) break
  }
  return out
}

const block = (page: WikiPage, lines: string[]): string => `- [[${page.title}]]\n${lines.map((l) => `  > ${l}`).join('\n')}`

// What the agent reads. `look` is the wiki's own page lookup, so a held page says nothing here.
export function handOffText(f: WikiFinding, look: (title: string) => WikiPage | undefined): string {
  if (f.kind === 'orphan') {
    const titles = f.pages.map((t) => `[[${t}]]`)
    const heads = f.pages.map((t) => {
      const p = look(t)
      return p ? `- [[${t}]] (${p.kind}): ${p.summary || L('sem resumo', 'no summary')}` : `- [[${t}]]`
    })
    return L(
      [
        `Isto vem da revisão da wiki. Estas páginas não são citadas por nenhuma outra: ${titles.join(', ')}.`,
        '',
        heads.join('\n'),
        '',
        'Encontre onde elas pertencem: procure as páginas que falam do mesmo assunto (wiki_indice, wiki_buscar) e ligue as duas pontas com wiki_escrever: o [[Título]] na página que deveria citá-la, dentro de uma frase que faça sentido, e um link de volta na própria página, que também a situe. Só os links e a frase que os fazem ler bem: não reescreva as páginas nem mude o que elas dizem. Se nenhuma outra página tiver a ver com uma delas, diga qual e por quê.',
        '',
        `No fim, diga em uma linha o que ligou a quê.`
      ].join('\n'),
      [
        `This comes from the wiki's review. Nothing links to these pages: ${titles.join(', ')}.`,
        '',
        heads.join('\n'),
        '',
        "Find where they belong: look for the pages about the same subject (wiki_indice, wiki_buscar) and link both ends with wiki_escrever: the [[Title]] on the page that should cite it, inside a sentence that reads well, and a link back on the page itself, that also places it. Only the links and the sentence that make them read well: don't rewrite the pages or change what they say. If no other page has anything to do with one of them, say which and why.",
        '',
        'At the end, say in one line what you linked to what.'
      ].join('\n')
    )
  }
  const name = f.name ?? f.pages[0] ?? ''
  const citing = f.pages.map((t) => look(t)).filter((p): p is WikiPage => !!p)
  const where = citing.map((p) => block(p, linesOf(p, [`[[${name}]]`, name]))).join('\n')
  const seen = f.pages.map((t) => `[[${t}]]`).join(', ')
  return L(
    [
      `Isto vem da revisão da wiki. ${f.kind === 'broken' ? `Uma página liga pra [[${name}]], que ainda não existe.` : `[[${name}]] aparece em ${f.pages.map((t) => `[[${t}]]`).join(', ')}, e não tem página.`}`,
      '',
      where || `(Não consegui abrir as páginas: veja ${seen} com wiki_ler.)`,
      '',
      `Leia essas páginas e escreva a página "${name}" com o que elas dizem: o título tem que ser exatamente esse, pra os links passarem a valer. Grave com wiki_escrever. Se as páginas não disserem o bastante pra página ficar de pé, diga o que falta em vez de inventar.`,
      '',
      'No fim, diga em uma linha o que a página tem e de onde veio.'
    ].join('\n'),
    [
      `This comes from the wiki's review. ${f.kind === 'broken' ? `A page links to [[${name}]], which doesn't exist yet.` : `[[${name}]] shows up in ${f.pages.map((t) => `[[${t}]]`).join(', ')}, and has no page.`}`,
      '',
      where || `(I couldn't open the pages: see ${seen} with wiki_ler.)`,
      '',
      `Read those pages and write the page "${name}" with what they say: the title has to be exactly that one, so the links start working. Write it with wiki_escrever. If the pages don't say enough for the page to stand, say what's missing instead of making it up.`,
      '',
      'At the end, say in one line what the page has and where it came from.'
    ].join('\n')
  )
}

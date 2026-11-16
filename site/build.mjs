// Builds the published site into dist/. Each page is one file we edit, with Portuguese and
// English side by side, and comes out twice: in Portuguese and in English, each at its own
// address with its own title, description, canonical address, hreflang links and structured
// data (what search engines and AI answers read), plus the sitemap.
// The guides (guias/, docs/) are written in Markdown instead, one file per language, and come out
// through guia.html, with an index per section and llms.txt (see guias/README.md). Every page gets
// the home page's PostHog snippet.
// `npx wrangler deploy` runs it first (wrangler.jsonc); `node build.mjs` to see dist/ by hand.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readGuide } from './guides.mjs'

const SITE = 'https://tucano.sh'
const here = (p) => new URL(p, import.meta.url)
const read = (f) => readFileSync(here(f), 'utf8')

// Replaces exactly one occurrence, so a change to a page can't silently skip a step.
function swap(html, from, to, file) {
  const n = html.split(from).length - 1
  if (n !== 1) throw new Error(`build.mjs: expected "${from}" once in ${file}, found ${n}`)
  return html.replace(from, () => to)
}

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const inLang = (html, lang) => {
  const m = html.match(new RegExp(`<span lang="${lang}">([\\s\\S]*?)</span>(?=<span lang=|$)`))
  if (!m) throw new Error(`build.mjs: no ${lang} text in ${html.slice(0, 80)}`)
  return text(m[1])
}

// The questions of a page (the block marked data-faq, or the home page's "Perguntas"), in each language.
function faqOf(html, file) {
  const at = html.search(/data-faq|id="perguntas"/)
  const block = html.slice(at, html.indexOf('</section>', at))
  const faq = [...block.matchAll(/<summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(([, q, a]) => ({ q, a }))
  if (at < 0 || faq.length < 3) throw new Error(`build.mjs: found ${faq.length} questions in ${file}`)
  return faq
}

const ORG = {
  '@type': 'Organization',
  '@id': `${SITE}/#org`,
  name: 'Tucano',
  url: `${SITE}/`,
  logo: `${SITE}/assets/brand/tucano-512.png`,
  sameAs: ['https://x.com/tucanosh', 'https://github.com/eduwxyz/tucano', 'https://discord.gg/uQp4x7wUgT'],
}
const faqPage = (faq, lang, url) => ({
  '@type': 'FAQPage',
  url,
  inLanguage: lang,
  mainEntity: faq.map(({ q, a }) => ({ '@type': 'Question', name: inLang(q, lang), acceptedAnswer: { '@type': 'Answer', text: inLang(a, lang) } })),
})
const jsonLd = (graph) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>\n`

// Canonical address, the other language and the social card's address, for a page that doesn't carry them.
const links = (lang, urls) => `<meta property="og:url" content="${urls[lang]}">
<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'pt_BR'}">
<meta property="og:locale:alternate" content="${lang === 'en' ? 'pt_BR' : 'en_US'}">
<link rel="canonical" href="${urls[lang]}">
<link rel="alternate" hreflang="pt-BR" href="${urls['pt-BR']}">
<link rel="alternate" hreflang="en" href="${urls.en}">
<link rel="alternate" hreflang="x-default" href="${urls.en}">
`

const out = {} // dist path → html
const sitemap = [] // [{ urls, lastmod? }]

// The analytics (PostHog) of the home page's <head>, for every other page too: one copy to change.
const HOME_SRC = read('index.html')
const ANALYTICS = (() => {
  const at = HOME_SRC.indexOf('<!-- Analytics (PostHog)')
  const end = HOME_SRC.indexOf('</script>', at) + '</script>'.length
  if (at < 0 || end < at) throw new Error('build.mjs: the PostHog snippet is missing from index.html')
  return `${HOME_SRC.slice(at, end)}\n`
})()

// The waitlist's anti-robot check (Cloudflare Turnstile): its public site key, for tucano.sh. The
// secret that goes with it is the worker's (`npx wrangler secret put TURNSTILE_SECRET`). To try the
// form on localhost, build with Cloudflare's test key, which lets everyone through:
//   TURNSTILE_SITE_KEY=1x00000000000000000000AA node build.mjs
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '0x4AAAAAAF4S07mYq5opawzS'
if (TURNSTILE_SITE_KEY.startsWith('1x0000')) console.warn('build.mjs: the waitlist uses Turnstile\'s test key: not for tucano.sh')

// ---------- the home page: Portuguese in its head, English in its script's META.en ----------
{
  const file = 'index.html'
  const src = read(file).replaceAll('__TURNSTILE_SITE_KEY__', TURNSTILE_SITE_KEY)
  const en = src.match(/en: \{\s*title: '([^']+)',\s*desc: '([^']+)',\s*og: '([^']+)'/)
  if (!en) throw new Error('build.mjs: META.en not found in index.html')
  const META = {
    'pt-BR': { title: src.match(/<title>([^<]+)<\/title>/)[1], desc: src.match(/id="metaDesc" content="([^"]+)"/)[1] },
    en: { title: en[1], desc: en[2], og: en[3] },
  }
  const faq = faqOf(src, file)
  const urls = { 'pt-BR': `${SITE}/`, en: `${SITE}/en/` }
  const data = (lang) => jsonLd([
    ORG,
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#app`,
      name: 'Tucano',
      url: urls[lang],
      description: META[lang].desc,
      inLanguage: lang,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'macOS, Windows, Linux',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      downloadUrl: 'https://github.com/eduwxyz/tucano/releases/latest',
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
      image: `${SITE}/assets/brand/og.png`,
      publisher: { '@id': `${SITE}/#org` },
    },
    faqPage(faq, lang, urls[lang]),
  ])

  out['index.html'] = swap(src.replace(/ data-en-href="[^"]*"/g, ''), '</head>', `${data('pt-BR')}</head>`, file)

  let e = src
  e = swap(e, '<html lang="pt-BR">', '<html lang="en">', file)
  e = swap(e, `<title>${META['pt-BR'].title}</title>`, `<title>${META.en.title}</title>`, file)
  e = swap(e, `id="metaDesc" content="${META['pt-BR'].desc}"`, `id="metaDesc" content="${META.en.desc}"`, file)
  e = swap(e, `id="ogTitle" content="${META['pt-BR'].title}"`, `id="ogTitle" content="${META.en.title}"`, file)
  e = e.replace(/id="ogDesc" content="[^"]+"/, `id="ogDesc" content="${META.en.og}"`)
  e = e.replace(/property="og:image:alt" content="[^"]+"/, 'property="og:image:alt" content="Tucano: Your AI agent team. Your rules."')
  e = swap(e, `<meta property="og:url" content="${SITE}/">`, `<meta property="og:url" content="${SITE}/en/">`, file)
  e = swap(e, '<meta property="og:locale" content="pt_BR">\n<meta property="og:locale:alternate" content="en_US">', '<meta property="og:locale" content="en_US">\n<meta property="og:locale:alternate" content="pt_BR">', file)
  e = swap(e, `<link rel="canonical" href="${SITE}/">`, `<link rel="canonical" href="${SITE}/en/">`, file)
  e = e.replace(/(href|src)="assets\//g, '$1="../assets/')
  e = e.replace(/href="(\/[^"]*)" data-en-href="([^"]*)"/g, 'href="$2"')
  out['en/index.html'] = swap(e, '</head>', `${data('en')}</head>`, file)
  sitemap.push(urls)
}

// ---------- the other pages: Portuguese as written, English in data-en and data-en-href ----------
const PAGES = [
  { file: 'alternativa-grok-bot.html', 'pt-BR': 'alternativa-grok-bot/', en: 'en/grok-bot-alternative/' },
  { file: 'alternativa-openclaw.html', 'pt-BR': 'alternativa-openclaw/', en: 'en/openclaw-alternative/' },
  { file: 'alternativa-hermes.html', 'pt-BR': 'alternativa-hermes/', en: 'en/hermes-alternative/' },
  { file: 'suporte.html', 'pt-BR': 'suporte/', en: 'en/support/' },
  { file: 'privacidade.html', 'pt-BR': 'privacidade/', en: 'en/privacy/', faq: false }, // no questions: no FAQPage
  { file: 'pro.html', 'pt-BR': 'pro/', en: 'en/pro/' },
]

// The home page's look and its Tucano Pro script, for the pages that ask for them (pro.html):
// one source for the styles and the waitlist form, so the two pages can't drift apart.
const home = HOME_SRC
const HOME_STYLE = home.slice(home.indexOf('<style>'), home.indexOf('</style>') + '</style>'.length)
const PRO_SCRIPT = home.slice(home.lastIndexOf('<script src="https://challenges.cloudflare.com'), home.lastIndexOf('</script>') + '</script>'.length)
for (const page of PAGES) {
  const src = read(page.file).replaceAll('<!-- STYLE:home -->', HOME_STYLE).replaceAll('<!-- SCRIPT:pro -->', PRO_SCRIPT).replaceAll('__TURNSTILE_SITE_KEY__', TURNSTILE_SITE_KEY)
  const urls = { 'pt-BR': `${SITE}/${page['pt-BR']}`, en: `${SITE}/${page.en}` }
  const faq = page.faq === false ? null : faqOf(src, page.file)
  const title = (lang) => lang === 'en' ? src.match(/<title data-en="([^"]+)">/)[1] : src.match(/<title[^>]*>([^<]+)<\/title>/)[1]
  const desc = (lang) => src.match(lang === 'en' ? /<meta name="description" content="[^"]+" data-en="([^"]+)">/ : /<meta name="description" content="([^"]+)"/)[1]
  const data = (lang) => jsonLd([
    ORG,
    { '@type': 'WebPage', '@id': `${urls[lang]}#page`, url: urls[lang], name: title(lang), description: desc(lang), inLanguage: lang, about: { '@id': `${SITE}/#app` }, publisher: { '@id': `${SITE}/#org` } },
    ...(faq ? [faqPage(faq, lang, urls[lang])] : []),
  ])
  if (src.includes('posthog.init')) throw new Error(`build.mjs: ${page.file} has its own PostHog; build.mjs adds the home page's`)
  const head = (lang) => `${links(lang, urls)}${data(lang)}${ANALYTICS}</head>`

  // Portuguese: the data-en attributes go; English: they replace what they sit next to.
  const pt = src.replace(/ data-en(-href)?="[^"]*"/g, '')
  let e = swap(src, '<html lang="pt-BR">', '<html lang="en">', page.file)
  e = e.replace(/<title data-en="([^"]+)">[^<]*<\/title>/, '<title>$1</title>')
  e = e.replace(/content="[^"]*" data-en="([^"]*)"/g, 'content="$1"')
  e = e.replace(/href="[^"]*" data-en-href="([^"]*)"/g, 'href="$1"')
  if (/ data-en(-href)?="/.test(e)) throw new Error(`build.mjs: a data-en in ${page.file} that isn't next to a content or href`)
  out[`${page['pt-BR']}index.html`] = swap(pt, '</head>', head('pt-BR'), page.file)
  out[`${page.en}index.html`] = swap(e, '</head>', head('en'), page.file)
  sitemap.push(urls)
}

// ---------- the guides: guias/<guide>/pt.md and en.md (and docs/, the same way) → pages and an index ----------
// How to write one: guias/README.md. A section with no guides yet publishes nothing.
const SECTIONS = [
  {
    dir: 'guias',
    'pt-BR': 'guias/', en: 'en/guides/',
    name: { 'pt-BR': 'Guias', en: 'Guides' },
    count: { 'pt-BR': (n) => (n === 1 ? '1 guia' : `${n} guias`), en: (n) => (n === 1 ? '1 guide' : `${n} guides`) },
    title: { 'pt-BR': 'Guias do Tucano', en: 'Tucano guides' },
    desc: {
      'pt-BR': 'Como instalar, configurar e usar o Tucano, o app grátis e open source em que um time de agentes de IA trabalha junto em canais.',
      en: 'How to install, set up and use Tucano, the free, open-source app where a team of AI agents works together in channels.',
    },
  },
  {
    dir: 'docs',
    'pt-BR': 'docs/', en: 'en/docs/',
    name: { 'pt-BR': 'Documentação', en: 'Docs' },
    count: { 'pt-BR': (n) => (n === 1 ? '1 página' : `${n} páginas`), en: (n) => (n === 1 ? '1 page' : `${n} pages`) },
    title: { 'pt-BR': 'Documentação do Tucano', en: 'Tucano docs' },
    desc: {
      'pt-BR': 'O que cada parte do Tucano faz: agentes, canais, conectores, permissões, aprovações, rotinas e memória.',
      en: 'What each part of Tucano does: agents, channels, connectors, permissions, approvals, routines and memory.',
    },
  },
]

const UI = {
  'pt-BR': {
    home: '/', getTucano: 'Baixar o Tucano', madeIn: 'Feito no Brasil.', crumbs: 'Caminho', updated: 'Atualizado em', questions: 'Perguntas',
    more: 'Mais guias', support: ['Suporte', '/suporte/'], privacy: ['Privacidade', '/privacidade/'], guides: ['Guias', '/guias/'],
    wrong: 'Viu algo errado ou desatualizado? <a href="https://github.com/eduwxyz/tucano/issues">Abra uma issue</a> que a gente corrige.',
    date: (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
  },
  en: {
    home: '/en/', getTucano: 'Get Tucano', madeIn: 'Made in Brazil.', crumbs: 'Breadcrumb', updated: 'Updated', questions: 'Questions',
    more: 'More guides', support: ['Support', '/en/support/'], privacy: ['Privacy', '/en/privacy/'], guides: ['Guides', '/en/guides/'],
    wrong: 'Spotted something wrong or out of date? <a href="https://github.com/eduwxyz/tucano/issues">Open an issue</a> and we\'ll fix it.',
    date: (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
  },
}
const LANGS = ['pt-BR', 'en']
const FILE = { 'pt-BR': 'pt.md', en: 'en.md' }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const GUIDE_PAGE = read('guia.html')
const fill = (vars) => GUIDE_PAGE.replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`build.mjs: guia.html asks for {{${k}}}, which build.mjs doesn't fill`)
  return vars[k]
})
const crumbsHtml = (trail) => trail.map(([name, url], i) => (i === trail.length - 1 ? `<span aria-current="page">${esc(name)}</span>` : `<a href="${url.replace(SITE, '')}">${esc(name)}</a>`)).join(' <span aria-hidden="true">›</span> ')
const breadcrumb = (trail) => ({ '@type': 'BreadcrumbList', itemListElement: trail.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })) })
const footer = (lang) => {
  const t = UI[lang]
  return [[`tucano.sh`, t.home], t.guides, ['GitHub', 'https://github.com/eduwxyz/tucano'], ['X (@tucanosh)', 'https://x.com/tucanosh'], ['Discord', 'https://discord.gg/uQp4x7wUgT'], t.support, t.privacy]
    .map(([name, href]) => `<a href="${href}">${esc(name)}</a>`).join('')
}
const faqHtml = (faq, lang) => faq.length ? `<section>
  <h2>${UI[lang].questions}</h2>
  <div class="qa" data-faq>
    ${faq.map(({ q, a }, i) => `<details${i ? '' : ' open'}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n    ')}
  </div>
</section>` : ''

const guides = [] // every guide, for llms.txt: { section, lang, url, title, desc, group }
for (const section of SECTIONS) {
  const root = here(`${section.dir}/`)
  const ids = existsSync(root) ? readdirSync(root).filter((d) => statSync(here(`${section.dir}/${d}`)).isDirectory()).sort() : []
  if (!ids.length) continue
  const sectionUrls = { 'pt-BR': `${SITE}/${section['pt-BR']}`, en: `${SITE}/${section.en}` }

  // Read and check both languages of each guide.
  const list = ids.map((id) => {
    const g = {}
    for (const lang of LANGS) {
      const file = `${section.dir}/${id}/${FILE[lang]}`
      if (!existsSync(here(file))) throw new Error(`build.mjs: ${file} is missing: every guide has pt.md and en.md`)
      g[lang] = readGuide(read(file), file)
      g[lang].url = `${sectionUrls[lang]}${g[lang].slug}/`
      g[lang].path = `${section[lang]}${g[lang].slug}/`
    }
    const [pt, en] = [g['pt-BR'], g.en]
    const where = `${section.dir}/${id}`
    if (pt.faq.length !== en.faq.length) throw new Error(`build.mjs: ${where}: ${pt.faq.length} questions in pt.md, ${en.faq.length} in en.md`)
    if (pt.howto !== en.howto || pt.steps.length !== en.steps.length) throw new Error(`build.mjs: ${where}: pt.md and en.md differ in howto or in the number of steps`)
    if (pt.updated !== en.updated) throw new Error(`build.mjs: ${where}: "atualizado" differs between pt.md and en.md`)
    return { id, ...g }
  })
  for (const lang of LANGS) {
    const seen = new Set()
    for (const g of list) {
      if (seen.has(g[lang].slug)) throw new Error(`build.mjs: two ${section.dir} guides with the slug "${g[lang].slug}"`)
      seen.add(g[lang].slug)
    }
  }
  const sorted = (lang) => [...list].sort((a, b) => a[lang].order - b[lang].order || a[lang].title.localeCompare(b[lang].title, lang))
  const groups = (lang) => {
    const by = new Map()
    for (const g of sorted(lang)) by.set(g[lang].group, [...(by.get(g[lang].group) || []), g])
    return [...by]
  }

  // Each guide's page.
  for (const g of list) {
    for (const lang of LANGS) {
      const t = UI[lang]
      const p = g[lang]
      const trail = [['Tucano', `${SITE}${t.home}`], [section.name[lang], sectionUrls[lang]], [p.title, p.url]]
      const graph = [
        ORG,
        {
          '@type': 'Article',
          '@id': `${p.url}#article`,
          headline: p.title,
          description: p.desc,
          inLanguage: lang,
          datePublished: p.published,
          dateModified: p.updated,
          mainEntityOfPage: p.url,
          image: `${SITE}/assets/brand/og.png`,
          author: { '@id': `${SITE}/#org` },
          publisher: { '@id': `${SITE}/#org` },
          about: { '@id': `${SITE}/#app` },
        },
        breadcrumb(trail),
        ...(p.howto ? [{ '@type': 'HowTo', name: p.title, description: p.desc, inLanguage: lang, step: p.steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text || s.name, url: `${p.url}#${s.id}` })) }] : []),
        ...(p.faq.length ? [{ '@type': 'FAQPage', url: p.url, inLanguage: lang, mainEntity: p.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }] : []),
      ]
      const others = list.filter((o) => o !== g && o[lang].group === p.group)
      const more = others.length ? `<section class="more">
  <h2>${t.more}</h2>
  <ul>${others.map((o) => `<li><a href="/${o[lang].path}">${esc(o[lang].title)}</a></li>`).join('')}</ul>
</section>` : ''
      const urls = { 'pt-BR': g['pt-BR'].url, en: g.en.url }
      const html = fill({
        lang,
        title: esc(p.title),
        desc: esc(p.desc),
        ogType: 'article',
        home: t.home,
        ptHref: `/${g['pt-BR'].path}`,
        enHref: `/${g.en.path}`,
        getTucano: t.getTucano,
        crumbsLabel: t.crumbs,
        crumbs: crumbsHtml(trail),
        eyebrow: `${esc(section.name[lang])} · ${esc(p.group)} · ${t.updated.toLowerCase()} ${t.date(p.updated)}`,
        main: `<article class="prose">
${p.html}
</article>
${faqHtml(p.faq, lang)}
<p class="updated">${t.updated} ${t.date(p.updated)}. ${t.wrong}</p>
${more}`,
        madeIn: t.madeIn,
        footerLinks: footer(lang),
      })
      out[`${p.path}index.html`] = swap(html, '</head>', `${links(lang, urls)}${jsonLd(graph)}${ANALYTICS}</head>`, `${section.dir}/${g.id}/${FILE[lang]}`)
      guides.push({ section, lang, url: p.url, title: p.title, desc: p.desc, group: p.group })
    }
    sitemap.push({ 'pt-BR': g['pt-BR'].url, en: g.en.url, lastmod: g.en.updated })
  }

  // The section's index: its guides, by group.
  for (const lang of LANGS) {
    const t = UI[lang]
    const trail = [['Tucano', `${SITE}${t.home}`], [section.name[lang], sectionUrls[lang]]]
    const body = groups(lang).map(([group, gs]) => `<section>
  <h2>${esc(group)}</h2>
  <ul class="guide-list">
    ${gs.map((g) => `<li><a href="/${g[lang].path}"><b>${esc(g[lang].title)}</b><span>${esc(g[lang].desc)}</span></a></li>`).join('\n    ')}
  </ul>
</section>`).join('\n')
    const graph = [
      ORG,
      { '@type': 'CollectionPage', '@id': `${sectionUrls[lang]}#page`, url: sectionUrls[lang], name: section.title[lang], description: section.desc[lang], inLanguage: lang, publisher: { '@id': `${SITE}/#org` }, hasPart: sorted(lang).map((g) => ({ '@id': `${g[lang].url}#article` })) },
      breadcrumb(trail),
    ]
    const html = fill({
      lang,
      title: esc(section.title[lang]),
      desc: esc(section.desc[lang]),
      ogType: 'website',
      home: t.home,
      ptHref: `/${section['pt-BR']}`,
      enHref: `/${section.en}`,
      getTucano: t.getTucano,
      crumbsLabel: t.crumbs,
      crumbs: crumbsHtml(trail),
      eyebrow: section.count[lang](list.length),
      main: `<p class="answer">${esc(section.desc[lang])}</p>\n${body}`,
      madeIn: t.madeIn,
      footerLinks: footer(lang),
    })
    out[`${section[lang]}index.html`] = swap(html, '</head>', `${links(lang, sectionUrls)}${jsonLd(graph)}${ANALYTICS}</head>`, `${section.dir}/ index`)
  }
  sitemap.push({ ...sectionUrls, lastmod: list.map((g) => g.en.updated).sort().at(-1) })
}

// ---------- llms.txt: what the site has, for AI tools that read it (llmstxt.org) ----------
{
  const line = (title, url, desc) => `- [${title}](${url})${desc ? `: ${desc}` : ''}`
  const part = (sectionDir, lang) => guides.filter((g) => g.section.dir === sectionDir && g.lang === lang)
  const blocks = []
  for (const section of SECTIONS) {
    for (const lang of ['en', 'pt-BR']) {
      const gs = part(section.dir, lang)
      if (!gs.length) continue
      blocks.push(`## ${section.title[lang]}${lang === 'pt-BR' ? ' (português)' : ''}\n\n${line(section.title[lang], `${SITE}/${section[lang]}`, '')}\n${gs.map((g) => line(g.title, g.url, g.desc)).join('\n')}`)
    }
  }
  out['llms.txt'] = `# Tucano

> Tucano is a free, open-source (Apache-2.0) app for macOS, Windows and Linux where a team of AI agents works together in channels, like a work chat. Agents run on the Claude Code, Codex, Cursor, Grok, Cline, Hermes, OpenCode or Pi already set up on your computer, with no API key, and you decide what each agent can read, write, and what waits for your approval. Tucano Pro is the paid, hosted version.

Every page exists in English and in Portuguese (pt-BR).

## Pages

${line('Tucano (home)', `${SITE}/en/`, 'what Tucano is, what it does, how to install it, questions')}
${line('Tucano Pro', `${SITE}/en/pro/`, 'Tucano hosted for you, always on')}
${line('OpenClaw alternative', `${SITE}/en/openclaw-alternative/`, 'Tucano compared with OpenClaw, Hermes Agent and NanoClaw')}
${line('Hermes Agent alternative', `${SITE}/en/hermes-alternative/`, 'Tucano compared with Hermes Agent, which Tucano can run as an engine')}
${line('Grok Bot alternative', `${SITE}/en/grok-bot-alternative/`, 'Tucano compared with Grok Bot, MausBot, OpenBot and Rerun')}
${line('Support', `${SITE}/en/support/`, '')}
${line('Source code', 'https://github.com/eduwxyz/tucano', 'README, changelog and releases')}

${blocks.join('\n\n')}
`
}

// ---------- the sitemap, with each page's two languages ----------
const today = new Date().toISOString().slice(0, 10)
const entries = sitemap.flatMap(({ lastmod, ...urls }) => {
  const alts = `<xhtml:link rel="alternate" hreflang="pt-BR" href="${urls['pt-BR']}"/><xhtml:link rel="alternate" hreflang="en" href="${urls.en}"/><xhtml:link rel="alternate" hreflang="x-default" href="${urls.en}"/>`
  return [urls['pt-BR'], urls.en].map((u) => `  <url><loc>${u}</loc><lastmod>${lastmod || today}</lastmod>${alts}</url>`)
})
out['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`

rmSync(here('dist/'), { recursive: true, force: true })
cpSync(here('assets/'), here('dist/assets/'), { recursive: true })
for (const f of ['_headers', 'robots.txt']) cpSync(here(f), here(`dist/${f}`))
for (const [path, html] of Object.entries(out)) {
  mkdirSync(new URL('.', here(`dist/${path}`)), { recursive: true })
  writeFileSync(here(`dist/${path}`), html)
}
console.log(`dist/: ${Object.keys(out).join(', ')}`)

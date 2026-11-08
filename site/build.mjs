// Builds the published site into dist/. Each page is one file we edit, with Portuguese and
// English side by side, and comes out twice: in Portuguese and in English, each at its own
// address with its own title, description, canonical address, hreflang links and structured
// data (what search engines and AI answers read), plus the sitemap.
// `npx wrangler deploy` runs it first (wrangler.jsonc); `node build.mjs` to see dist/ by hand.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

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
const sitemap = [] // [{ urls }]

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
  { file: 'suporte.html', 'pt-BR': 'suporte/', en: 'en/support/' },
  { file: 'privacidade.html', 'pt-BR': 'privacidade/', en: 'en/privacy/', faq: false }, // no questions: no FAQPage
  { file: 'pro.html', 'pt-BR': 'pro/', en: 'en/pro/' },
]

// The home page's look and its Tucano Pro script, for the pages that ask for them (pro.html):
// one source for the styles and the waitlist form, so the two pages can't drift apart.
const home = read('index.html')
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
  const head = (lang) => `${links(lang, urls)}${data(lang)}</head>`

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

// ---------- the sitemap, with each page's two languages ----------
const today = new Date().toISOString().slice(0, 10)
const entries = sitemap.flatMap((urls) => {
  const alts = `<xhtml:link rel="alternate" hreflang="pt-BR" href="${urls['pt-BR']}"/><xhtml:link rel="alternate" hreflang="en" href="${urls.en}"/><xhtml:link rel="alternate" hreflang="x-default" href="${urls.en}"/>`
  return [urls['pt-BR'], urls.en].map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod>${alts}</url>`)
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

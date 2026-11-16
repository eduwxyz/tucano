// The guides: the Markdown reader (guides.mjs) and what build.mjs makes of them, run on a copy of
// the site so dist/ here is left alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frontMatter, markdown, readGuide } from './guides.mjs'

const SITE_DIR = fileURLToPath(new URL('.', import.meta.url))

const guide = (over = '', body = 'The answer, first.\n\n## 1. One\n\nDo this.\n\n## 2. Two\n\nThen that.\n') => `---
slug: how-to-x
titulo: How do I do X?
descricao: Short.
atualizado: 2026-11-15
grupo: Getting started
howto: sim
faq:
  - pergunta: Is it free?
    resposta: "Yes: free."
  - pergunta: Another?
    resposta: Another answer.
${over}---
${body}`

test('front matter: fields, quotes and the faq list', () => {
  const { data, body } = frontMatter(guide(), 'x.md')
  assert.equal(data.titulo, 'How do I do X?')
  assert.deepEqual(data.faq, [{ pergunta: 'Is it free?', resposta: 'Yes: free.' }, { pergunta: 'Another?', resposta: 'Another answer.' }])
  assert.match(body, /^The answer, first\./)
})

test('markdown: headings get ids, code is escaped, links and lists come out', () => {
  const { html, headings } = markdown('Para with **bold**, `<b>` and [a link](/guias/x/).\n\n## Ação rápida\n\n- one\n- two\n  more\n\n1. first\n2. second\n\n```bash\necho "<hi>" && ls\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> A note.')
  assert.match(html, /<p>Para with <b>bold<\/b>, <code>&lt;b&gt;<\/code> and <a href="\/guias\/x\/">a link<\/a>\.<\/p>/)
  assert.match(html, /<h2 id="acao-rapida">Ação rápida<\/h2>/)
  assert.match(html, /<ul><li>one<\/li><li>two more<\/li><\/ul>/)
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/)
  assert.match(html, /<pre><code class="lang-bash">echo &quot;&lt;hi&gt;&quot; &amp;&amp; ls<\/code><\/pre>/)
  assert.match(html, /<th>a<\/th><th>b<\/th>.*<td>1<\/td><td>2<\/td>/)
  assert.match(html, /<aside class="note"><p>A note\.<\/p><\/aside>/)
  assert.deepEqual(headings.map((h) => h.id), ['acao-rapida'])
})

test('markdown: raw HTML in the text is escaped, not run', () => {
  assert.doesNotMatch(markdown('<script>alert(1)</script>').html, /<script>/)
})

test('markdown: links go only to /, #, https://, http:// and mailto:', () => {
  for (const ok of ['/guias/x/', '#passo', 'https://tucano.sh/', 'http://localhost:3000/', 'mailto:oi@tucano.sh']) {
    assert.match(markdown(`[x](${ok})`).html, new RegExp(`<a href="${ok.replace(/[/.?]/g, '\\$&')}">x</a>`))
  }
  for (const bad of ['javascript:location=1', 'JavaScript:alert(1)', 'data:text/html,hi', 'vbscript:x', '//evil.example/', '/\\evil.example/', 'relative/path']) {
    assert.throws(() => markdown(`Text [x](${bad}).`, 'en.md'), /en\.md: link .*only addresses starting with/, bad)
  }
  assert.throws(() => readGuide(guide('', 'Answer [x](javascript:alert(1)).\n\n## 1. One\n\nA.\n\n## 2. Two\n\nB.\n'), 'en.md'), /link/)
})

test('markdown: a * in a link address stays in the address', () => {
  const { html } = markdown('See [*the* page](https://x.example/a*b*c) and *this*.')
  assert.match(html, /<a href="https:\/\/x\.example\/a\*b\*c"><em>the<\/em> page<\/a> and <em>this<\/em>\./)
})

test('a guide: Windows line endings and a bad "ordem"', () => {
  assert.equal(readGuide(guide().replace(/\n/g, '\r\n'), 'en.md').title, 'How do I do X?')
  assert.equal(readGuide(guide('ordem: 3\n'), 'en.md').order, 3)
  assert.throws(() => readGuide(guide('ordem: two\n'), 'en.md'), /"ordem" is a whole number/)
})

test('a guide: the answer, the steps and the questions', () => {
  const g = readGuide(guide(), 'en.md')
  assert.equal(g.answer, 'The answer, first.')
  assert.deepEqual(g.steps.map((s) => [s.name, s.id, s.text]), [['One', '1-one', 'Do this.'], ['Two', '2-two', 'Then that.']])
  assert.equal(g.faq.length, 2)
})

test('a guide: what it refuses, with a message that says why', () => {
  assert.throws(() => readGuide(guide().replace('How do I do X?', 'Doing X'), 'en.md'), /question the page answers/)
  assert.throws(() => readGuide(guide().replace('slug: how-to-x', 'slug: How To'), 'en.md'), /slug/)
  assert.throws(() => readGuide(guide().replace('grupo: Getting started\n', ''), 'en.md'), /"grupo" is missing/)
  assert.throws(() => readGuide(guide('', 'Answer.\n\n## Not a step\n\nText.\n'), 'en.md'), /at least two steps/)
  assert.throws(() => readGuide(guide('', '# Title\n\nAnswer.'), 'en.md'), /no # headings/)
  assert.throws(() => readGuide(guide().replace('    resposta: Another answer.\n', ''), 'en.md'), /"pergunta" and a "resposta"/)
})

// build.mjs on a copy of the site (with one more guide in docs/), then what came out.
function build(extra = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-site-'))
  for (const f of readdirSync(SITE_DIR)) if (f !== 'dist' && f !== 'node_modules') cpSync(join(SITE_DIR, f), join(dir, f), { recursive: true })
  extra(dir)
  execFileSync(process.execPath, ['build.mjs'], { cwd: dir, stdio: 'pipe' })
  return { dir, read: (p) => readFileSync(join(dir, 'dist', p), 'utf8'), has: (p) => existsSync(join(dir, 'dist', p)) }
}
const ld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1])['@graph']

test('build: the example guide in both languages, with its structured data', () => {
  const site = build()
  try {
    const pt = site.read('guias/como-instalar-o-tucano-no-mac/index.html')
    const en = site.read('en/guides/how-to-install-tucano-on-mac/index.html')
    assert.match(pt, /<html lang="pt-BR">/)
    assert.match(en, /<html lang="en">/)
    assert.match(pt, /<link rel="canonical" href="https:\/\/tucano.sh\/guias\/como-instalar-o-tucano-no-mac\/">/)
    assert.match(pt, /hreflang="en" href="https:\/\/tucano.sh\/en\/guides\/how-to-install-tucano-on-mac\/"/)
    assert.doesNotMatch(pt + en, /\{\{\w+\}\}/)
    const types = ld(en).map((n) => n['@type'])
    assert.deepEqual(types, ['Organization', 'Article', 'BreadcrumbList', 'HowTo', 'FAQPage'])
    const howto = ld(en).find((n) => n['@type'] === 'HowTo')
    assert.equal(howto.step.length, 3)
    assert.equal(ld(pt).find((n) => n['@type'] === 'Article').dateModified, '2026-11-15')
    assert.match(site.read('guias/index.html'), /href="\/guias\/como-instalar-o-tucano-no-mac\/"/)
    assert.match(site.read('en/guides/index.html'), /href="\/en\/guides\/how-to-install-tucano-on-mac\/"/)
    assert.ok(!site.has('docs/index.html'), 'no docs yet: no /docs/ page')
  } finally { rmSync(site.dir, { recursive: true, force: true }) }
})

test('build: llms.txt, the sitemap, and PostHog on every page', () => {
  const site = build((dir) => {
    mkdirSync(join(dir, 'docs/conectores'), { recursive: true })
    for (const [f, slug] of [['pt.md', 'o-que-e-um-conector'], ['en.md', 'what-is-a-connector']]) {
      writeFileSync(join(dir, 'docs/conectores', f), guide('', 'An answer.\n\n## 1. One\n\nA.\n\n## 2. Two\n\nB.\n').replace('slug: how-to-x', `slug: ${slug}`))
    }
  })
  try {
    const llms = site.read('llms.txt')
    assert.match(llms, /^# Tucano\n\n> /)
    assert.match(llms, /- \[How do I install Tucano on a Mac\?\]\(https:\/\/tucano.sh\/en\/guides\/how-to-install-tucano-on-mac\/\): /)
    assert.match(llms, /- \[Como instalar o Tucano no Mac\?\]\(https:\/\/tucano.sh\/guias\/como-instalar-o-tucano-no-mac\/\)/)
    assert.match(llms, /https:\/\/tucano.sh\/en\/docs\/what-is-a-connector\//)
    assert.ok(site.has('docs/index.html') && site.has('en/docs/what-is-a-connector/index.html'))
    const sitemap = site.read('sitemap.xml')
    assert.match(sitemap, /<loc>https:\/\/tucano.sh\/guias\/como-instalar-o-tucano-no-mac\/<\/loc><lastmod>2026-11-15<\/lastmod>/)
    assert.match(sitemap, /<loc>https:\/\/tucano.sh\/en\/guides\/<\/loc>/)
    const pages = [...sitemap.matchAll(/<loc>https:\/\/tucano.sh\/([^<]*)<\/loc>/g)].map((m) => `${m[1]}index.html`)
    assert.ok(pages.length >= 20)
    for (const p of pages) assert.equal(site.read(p).split('posthog.init(').length - 1, 1, `PostHog once in ${p}`)
  } finally { rmSync(site.dir, { recursive: true, force: true }) }
})

test('build: a guide missing its English file stops the build', () => {
  assert.throws(() => build((dir) => rmSync(join(dir, 'guias/instalar-no-mac/en.md'))), /en\.md is missing/)
})

// A release, told on Discord (#announcements) with what's in it: the Portuguese list at the top of
// the notes, then the English section's headlines, and a link to the whole notes and the downloads.
// GitHub's own Discord hook only says "New release published". Run by .github/workflows/discord-release.yml
// on a published release, with the webhook in DISCORD_RELEASE_WEBHOOK; DRY_RUN=1 prints the message instead.
// DISCORD_RELEASE_ROLE (a role's id, @Release Pings on the Tucano server) is pinged, and no one else.
// By hand, for a release already out: `TAG=v0.2.36 DRY_RUN=1 node scripts/discord-release.mjs` (needs gh).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const LIMIT = 4096 // an embed's description
const ORANGE = 0xf2731f

// The release: from the event GitHub hands the workflow, or from gh for a tag.
function release() {
  const path = process.env.GITHUB_EVENT_PATH
  if (path) {
    const r = JSON.parse(readFileSync(path, 'utf8')).release
    return { name: r.name || r.tag_name, url: r.html_url, body: r.body ?? '', draft: r.draft, prerelease: r.prerelease }
  }
  const tag = process.env.TAG
  if (!tag) throw new Error('TAG is needed outside a workflow (e.g. TAG=v0.2.36)')
  const r = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'name,url,body,isDraft,isPrerelease'], { encoding: 'utf8' }))
  return { name: r.name || tag, url: r.url, body: r.body, draft: r.isDraft, prerelease: r.isPrerelease }
}

// "> **Em português:**" and the quoted lines under it.
export function portuguese(body) {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^>\s*\*\*Em português:?\*\*/i.test(l.trim()))
  if (start < 0) return []
  const out = []
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('>')) break
    const text = l.replace(/^>\s?/, '').trimEnd()
    if (text) out.push(text)
  }
  return out
}

// Each English bullet's bold lead, under its heading: "New: Lend your computer…", "Fixed: …".
export function english(body) {
  const kind = { added: 'New', changed: 'Changed', fixed: 'Fixed', removed: 'Removed', security: 'Security' }
  const out = []
  let now = ''
  for (const l of body.split(/\r?\n/)) {
    const head = /^###\s+(\w+)/.exec(l)
    if (head) {
      now = kind[head[1].toLowerCase()] ?? ''
      continue
    }
    if (/^##\s/.test(l)) now = ''
    const lead = now && /^- \*\*(.+?)\*\*/.exec(l)
    if (lead) out.push(`- ${now}: ${lead[1].replace(/\.$/, '')}`)
  }
  return out
}

// The message: the lists, cut at a whole line to fit, and the way to the rest.
export function message({ name, url, body }, role = '') {
  const more = `\n\n[Notas completas e download · Full notes and downloads](${url})`
  const pt = portuguese(body)
  const en = english(body)
  const parts = [...pt, ...(en.length ? ['', '**In English:**', ...en] : [])]
  let text = ''
  for (const line of parts) {
    const next = text ? `${text}\n${line}` : line
    if (next.length + more.length + 2 > LIMIT) {
      text += '\n…'
      break
    }
    text = next
  }
  return {
    username: 'Tucano',
    ...(role ? { content: `<@&${role}>` } : {}),
    allowed_mentions: { parse: [], roles: role ? [role] : [] },
    embeds: [{ title: `${name} saiu`, url, color: ORANGE, description: (text || 'Uma versão nova do Tucano.') + more, footer: { text: 'O Tucano se atualiza sozinho · Tucano updates itself' } }]
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = release()
  if (r.draft || r.prerelease) {
    console.log('A draft or prerelease: nothing posted.')
    process.exit(0)
  }
  const payload = message(r, (process.env.DISCORD_RELEASE_ROLE ?? '').trim())
  if (process.env.DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2))
    process.exit(0)
  }
  const hook = process.env.DISCORD_RELEASE_WEBHOOK
  if (!hook) throw new Error('DISCORD_RELEASE_WEBHOOK is not set')
  const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error(`Discord said ${res.status}: ${await res.text()}`)
  console.log(`Posted ${r.name} to Discord.`)
}

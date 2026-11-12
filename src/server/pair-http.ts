// A one-time code (pair-codes.ts) at the door: the browser's link (/?code=) and POST /pair.
//
// Opening the link never spends the code. Link previews (Discord, WhatsApp, iMessage, Slack), a
// browser's prefetch or prerender of a pasted address, and mail scanners all open links before the
// person does: each would spend the code on a device no one holds, and the person's own visit would
// find it used. So the link answers a page that only looks at the code and asks; its button posts
// the code back (same origin only), and that spends it, once.
//
// POST /pair also takes the phone's (or a program's) JSON, as before: {code, name, platform} → {key}.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BASE_HEADERS, body, type Doors, sameOrigin } from './guard'
import { browserName, CODE_SHAPE, deviceLabel } from './pair-codes'
import { esc, PAGE_CSP, PAGE_STYLE } from './people'

export interface PairDoor {
  codes: { peek(code: unknown): { person: string | null } | undefined; spend(code: unknown): { person: string | null } | undefined }
  doors: Doors
  // The core's key for a new device of this person (null: the owner), or undefined.
  mint(person: string | null, label: string): Promise<string | undefined>
  owner(): string // whose Tucano it is, by name ('' before they said it)
  nameOf(person: string | null): string | undefined
}

const USED =
  'Esse código já foi usado ou passou do prazo. Gere outro. · That code was already used or has expired. Make a new one.'

// A browser that only asks ahead (Chrome's prefetch and prerender, Firefox's link prefetch, Safari's
// preload): Sec-Purpose, or the older Purpose, X-Purpose and X-Moz.
export function prefetching(req: Pick<IncomingMessage, 'headers'>): boolean {
  const h = req.headers
  return /prefetch|prerender|preview/i.test([h['sec-purpose'], h['purpose'], h['x-purpose'], h['x-moz']].flat().filter(Boolean).join(' '))
}

export const cookieFor = (req: Pick<IncomingMessage, 'headers'>, key: string): string =>
  `tucano=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`

// Same-origin, not no-referrer: with no-referrer the browser sends a form's POST with `Origin: null`,
// which /join and /pair (rightly) refuse as another site's.
export function htmlPage(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { ...BASE_HEADERS, 'referrer-policy': 'same-origin', 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY' }).end(html)
}

const shell = (inner: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Tucano</title><style>${PAGE_STYLE}</style><main>${inner}</main>`

// "Entrar no Tucano de <owner>": whose it is, as whom, and one button that spends the code.
export function pairPage(o: { owner: string; code: string; as?: string }): string {
  const whose = o.owner.trim()
  const title = whose ? `Entrar no Tucano de ${whose} · Sign in to ${whose}'s Tucano` : 'Entrar no Tucano · Sign in to Tucano'
  const as = o.as?.trim()
  return shell(
    `<h2>${esc(title)}</h2>${as ? `<p>Este navegador vai entrar como <b>${esc(as)}</b>. · This browser will sign in as <b>${esc(as)}</b>.</p>` : ''}<p>O link vale uma vez. Se não foi você quem pediu, feche esta página. · The link works once. If you didn't ask for it, close this page.</p><form method="post" action="./pair"><input type="hidden" name="code" value="${esc(o.code)}"><button type="submit">Entrar neste navegador · Sign in on this browser</button></form>`
  )
}

export const USED_PAGE = shell(
  '<h2>Este link já foi usado ou passou do prazo. · This link was already used or has expired.</h2><p>Gere outro em Configurações › Pessoas › Conectar um celular, ou com <code>node out/main/server.js pair</code>. · Make a new one in Settings › People › Connect a phone, or with <code>node out/main/server.js pair</code>.</p>'
)

const blocked = (res: ServerResponse): void => void res.writeHead(429, { ...BASE_HEADERS, 'retry-after': '600' }).end()

// GET /?code=: the page that asks. Only looks at the code: a wrong, used or late one counts as a
// guess at the invite's door, as spending it did. A prefetch gets nothing (and costs no guess): the
// person's own visit asks again.
export function pairLinkPage(door: PairDoor, req: IncomingMessage, res: ServerResponse, ip: string, code: string): void {
  if (door.doors.blocked('join', ip)) return blocked(res)
  if (prefetching(req)) return void res.writeHead(503, { ...BASE_HEADERS, 'cache-control': 'no-store', 'retry-after': '1' }).end()
  const found = CODE_SHAPE.test(code) ? door.codes.peek(code) : undefined
  if (!found) {
    door.doors.fail('join', ip)
    return htmlPage(res, USED_PAGE, 410)
  }
  htmlPage(res, pairPage({ owner: door.owner(), code, as: door.nameOf(found.person) }))
}

// POST /pair: the page's form (this browser, signed in by a cookie) or the phone's JSON (the key
// itself). A code that's wrong, used or late answers 410 and counts as a guess at the invite's door.
export async function pairPost(door: PairDoor, req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
  if (door.doors.blocked('join', ip)) return blocked(res)
  const form = /application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] ?? ''))
  // A form from another site would sign this browser in as someone else's device.
  if (form && !sameOrigin(req)) return void res.writeHead(403, BASE_HEADERS).end()
  let asked: { code?: unknown; name?: unknown; platform?: unknown } = {}
  try {
    const text = await body(req, 4 * 1024)
    asked = form ? { code: new URLSearchParams(text).get('code') ?? '' } : (JSON.parse(text) as typeof asked)
  } catch {
    return void res.writeHead(400, BASE_HEADERS).end()
  }
  const label = form ? deviceLabel(browserName(String(req.headers['user-agent'] ?? '')), 'browser') : deviceLabel(asked?.name, asked?.platform)
  const spent = door.codes.spend(asked?.code)
  const key = spent ? await door.mint(spent.person, label) : undefined
  if (!key) {
    door.doors.fail('join', ip)
    if (form) return htmlPage(res, USED_PAGE, 410)
    return void res.writeHead(410, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ error: USED }))
  }
  if (form) return void res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': cookieFor(req, key), location: '/', 'cache-control': 'no-store' }).end()
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ key }))
}

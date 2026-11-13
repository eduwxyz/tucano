// Notifications over every window, as Telegram's are: what an agent needs from me, what just
// happened, and how long each stays. The card is drawn by src/renderer/src/notice/Notice.tsx in a
// window of its own (src/main/notice.ts), and what waits on a decision comes from the core with
// `noticeFeed`. The rules live here so the window, the core and the tests read them the same way.
import { L } from './lang'
import { ACCESS_REQUEST } from './types'
import type { Lang } from './lang'
import type { Agent, Approval, ArtifactKind, Conversation, Inbox, Settings } from './types'

export const NOTICE_SECONDS = 6 // what a card stays once it's shown, before it fades
export const NOTICE_MIN_SECONDS = 3
export const NOTICE_MAX_SECONDS = 30
// The fade itself, which the pointer can undo by coming back: the small delay that keeps a card
// from vanishing in the moment between leaving it and reaching it again.
export const NOTICE_LINGER = 700
export const NOTICE_WIDTH = 372 // px, the column at the top right
export const NOTICE_MAX_FULL = 3 // cards at full height; the older ones fold into the tray below
export const NOTICE_MAX = 18 // kept at all, the oldest leaving first

// Settings › General › Notifications. Each unset one reads as its default, so the app shows them
// without anyone choosing anything first.
// How the cards are painted: the app's own warm palette, or the system's surfaces and accent, which
// is what Windows 11, the Mac and the Linux desktops each draw their own panels with.
export type NoticeSkin = 'light' | 'dark' | 'system'

export interface NoticeSettings {
  on?: boolean // a card over everything, instead of the system's own notification (default on)
  act?: boolean // approve and answer from the card itself (default on)
  seconds?: number // how long a card stays (default NOTICE_SECONDS)
  hover?: boolean // the pointer on the stack holds the cards there (default on)
  area?: NoticeArea // where the cards are, chosen on screen (default: the bottom right corner)
  skin?: NoticeSkin // light, dark, or whatever the system is on (default)
  stack?: boolean // one card at a time, the rest waiting behind it (default: the list)
}

export interface NoticeRules {
  on: boolean
  act: boolean
  seconds: number
  hover: boolean
  area?: NoticeArea // where the cards are; unset: the bottom right corner
  skin: NoticeSkin
  stack: boolean // one card at a time, the rest behind it
}

export const noticeOf = (s: Pick<Settings, 'notice'>): NoticeRules => ({
  on: s.notice?.on !== false,
  act: s.notice?.act !== false,
  seconds: Math.min(NOTICE_MAX_SECONDS, Math.max(NOTICE_MIN_SECONDS, Math.round(s.notice?.seconds ?? NOTICE_SECONDS))),
  hover: s.notice?.hover !== false,
  skin: s.notice?.skin === 'light' || s.notice?.skin === 'dark' ? s.notice.skin : 'system',
  stack: s.notice?.stack === true,
  ...(s.notice?.area ? { area: clampArea(s.notice.area) } : {})
})

export type NoticeKind = 'approval' | 'ask' | 'done' | 'note'

// Where the cards are: a rectangle of the screen, in fractions of the work area (so it follows a
// bigger or smaller display), and which way a stack grows in it. `up`: from its bottom edge, for one
// at the bottom of the screen; not: from its top edge, for one at the top.
export interface NoticeArea {
  x: number
  y: number
  w: number
  h: number
  up: boolean
}

export const NOTICE_PAD = 18 // px of room around the cards, inside their window: their shadow, and where they come in from
export const NOTICE_MIN_W = 280 // px: narrower, and a card's words stop fitting
export const NOTICE_MIN_H = 96

const between = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo))

// Kept inside the work area and never smaller than a card: what the person drew, or what the app can
// still show.
export function clampArea(a: NoticeArea): NoticeArea {
  const w = between(a.w, 0.12, 1)
  const h = between(a.h, 0.06, 1)
  return { x: between(a.x, 0, 1 - w), y: between(a.y, 0, 1 - h), w, h, up: a.up !== false }
}

// The default: the bottom right corner, a column as wide as a card and most of the screen's height,
// with the newest card nearest the corner.
export function defaultArea(workArea: { width: number; height: number }): NoticeArea {
  const w = Math.min(0.5, Math.max(0.12, NOTICE_WIDTH / Math.max(1, workArea.width)))
  const margin = 14 / Math.max(1, workArea.width)
  // Its middle sits below the screen's, so the stack grows up from the bottom of it.
  return clampArea({ x: 1 - w - margin, y: 0.14, w, h: 0.8, up: true })
}

// The rectangle on screen, from the fractions and the display it's on.
export function areaRect(a: NoticeArea, workArea: { x: number; y: number; width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const c = clampArea(a)
  return {
    x: Math.round(workArea.x + c.x * workArea.width),
    y: Math.round(workArea.y + c.y * workArea.height),
    w: Math.round(c.w * workArea.width),
    h: Math.round(c.h * workArea.height)
  }
}

// An image or a file a reply showed, as the card shows it: the app's own address for the artifact.
export interface NoticePicture {
  url: string
  title: string
  kind: ArtifactKind
}

// One card. `at` orders the stack (newest first); `id` is what the stack remembers: the same
// approval arriving twice is one card.
export interface NoticeCard {
  id: string
  kind: NoticeKind
  at: number
  title: string
  body: string
  meta?: string // the exact action of an approval: the tool and the connector
  agentId?: string
  agentName?: string
  conversationId?: string
  threadId?: string
  page?: 'skills' // a click opens that screen instead of a conversation
  approval?: Approval // what the buttons decide
  ask?: Inbox['questions'][number]
  pictures?: NoticePicture[]
  preview?: boolean // a card Settings › Notifications › Test every kind made: nothing to decide
  previewAgent?: number // which of the team's agents leans on its corner, by place
}

// What the core says as it happens (git-tucano's notify), once the main process decides the card
// shows over the window instead of the system's notification.
export interface NoticePush {
  title: string
  body: string
  conversationId?: string
  threadId?: string
  kind?: 'approval' | 'question' | 'done'
  page?: 'skills'
  messageId?: string
  pictures?: NoticePicture[]
  at?: number
}

// What the window reads from the core: how the cards are set, what waits on me, and the names to
// say where each one happened.
export interface NoticeFeed {
  rules: NoticeRules
  language: Lang // the app's: the cards' words follow it
  agents: Pick<Agent, 'id' | 'name' | 'color' | 'customColor' | 'picture' | 'avatar'>[]
  conversations: Pick<Conversation, 'id' | 'name' | 'kind'>[]
  inbox: Inbox
}

const agentName = (feed: Pick<NoticeFeed, 'agents'>, id: string | undefined): string => feed.agents.find((a) => a.id === id)?.name ?? L('Agente', 'Agent')

// Where it happened, as the app's own screens say it.
export function noticeWhere(conversations: NoticeFeed['conversations'], conversationId: string | undefined, who: string | undefined): string {
  const conv = conversations.find((c) => c.id === conversationId)
  if (!conv) return L('numa conversa que você não vê', "in a conversation you don't see")
  if (conv.kind === 'channel') return L(`em #${conv.name}`, `in #${conv.name}`)
  return who ? L(`na sua DM com ${who}`, `in your DM with ${who}`) : L('na sua DM', 'in your DM')
}

// The tool and the connector, or what a grant asks for: the line under an approval's title.
function approvalMeta(a: Approval): string {
  if (a.tool === ACCESS_REQUEST) return `${a.connectorName} · ${a.args['nivel'] === 'read_write' ? L('ler e escrever', 'read and write') : L('ler', 'read')}`
  return `${a.tool} · ${a.connectorName}`
}

export function approvalCard(a: Approval, who: string): NoticeCard {
  const title =
    a.tool === ACCESS_REQUEST
      ? L(`${who} pede acesso a ${a.connectorName}`, `${who} asks for access to ${a.connectorName}`)
      : a.highRisk
        ? L(`${who} pede uma aprovação de alto risco`, `${who} asks for a high-risk approval`)
        : L(`${who} pede aprovação`, `${who} asks for approval`)
  return {
    id: `approval:${a.id}`,
    kind: 'approval',
    at: a.createdAt,
    title,
    // What it's for. Missing, the exact action is the whole story.
    body: a.why || L('O agente parou esperando você. A conversa tem os detalhes.', 'The agent stopped, waiting for you. The conversation has the details.'),
    meta: approvalMeta(a),
    agentId: a.agentId,
    agentName: who,
    conversationId: a.conversationId,
    approval: a
  }
}

export function askCard(q: Inbox['questions'][number], who: string): NoticeCard {
  return {
    id: `ask:${q.id}`,
    kind: 'ask',
    at: q.createdAt,
    title: L(`${who} pergunta`, `${who} asks`),
    body: q.text,
    agentId: q.agentId,
    agentName: who,
    ...(q.conversationId ? { conversationId: q.conversationId } : {}),
    ...(q.threadId ? { threadId: q.threadId } : {}),
    ask: q
  }
}

// What waits on me, newest first: the approvals I may decide and the questions asked to me. Their
// ids are the same across feed reads, so a card already on screen is not drawn twice.
export function waitingCards(feed: NoticeFeed): NoticeCard[] {
  return [
    ...feed.inbox.approvals.map((a) => approvalCard(a, agentName(feed, a.agentId))),
    ...feed.inbox.questions.map((q) => askCard(q, agentName(feed, q.agentId)))
  ].sort((a, b) => b.at - a.at)
}

// A card for what just happened, or none: an approval and a question already have their card, from
// what waits on me, with the buttons that decide them.
export function pushCard(p: NoticePush, now = Date.now()): NoticeCard | null {
  if (p.kind === 'approval' || p.kind === 'question') return null
  const at = p.at ?? now
  return {
    id: p.messageId ? `done:${p.messageId}` : `note:${at}`,
    kind: p.kind === 'done' ? 'done' : 'note',
    at,
    title: p.title,
    body: p.body,
    ...(p.conversationId ? { conversationId: p.conversationId } : {}),
    ...(p.threadId ? { threadId: p.threadId } : {}),
    ...(p.page ? { page: p.page } : {}),
    ...(p.pictures?.length ? { pictures: p.pictures } : {})
  }
}

// The stack: what waits on me and what just happened, newest first, one card per thing, what the
// person closed left out.
export function stackCards(waiting: NoticeCard[], pushed: NoticeCard[], closed: ReadonlySet<string>): NoticeCard[] {
  const seen = new Set<string>()
  const kept: NoticeCard[] = []
  for (const c of [...waiting, ...pushed]) {
    if (closed.has(c.id) || seen.has(c.id)) continue
    seen.add(c.id)
    kept.push(c)
  }
  return kept.sort((a, b) => b.at - a.at).slice(0, NOTICE_MAX)
}

// What the stack mode keeps in front: what waits on a decision before what only happened, and the
// newest of each. An approval can stop an agent, a finished reply can wait.
const KIND_RANK: Record<NoticeKind, number> = { approval: 0, ask: 1, done: 2, note: 3 }
export const deckOrder = (cards: NoticeCard[]): NoticeCard[] => [...cards].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at - a.at)

// How long a card has: the seconds it was given, then the fade the pointer can still undo. `left`
// counts the milliseconds of those seconds down; past zero it counts the fade itself, negative.
export interface NoticeClock {
  left: number
}

export const startClock = (seconds: number): NoticeClock => ({ left: seconds * 1000 })

// A card on screen while the pointer is on it holds its place, and comes back from the fade if it
// was already fading: what the person aimed at never disappears under the pointer.
export const runClock = (c: NoticeClock, dt: number, held: boolean): NoticeClock => ({ left: held ? Math.max(c.left, 0) : c.left - dt })

export const clockPart = (c: NoticeClock, seconds: number): number => (seconds > 0 ? Math.min(1, Math.max(0, c.left / (seconds * 1000))) : 0)
export const clockFading = (c: NoticeClock): boolean => c.left < 0
export const clockGone = (c: NoticeClock): boolean => c.left <= -NOTICE_LINGER


// One card of every kind Settings can show, for the button that lets a person see them all at once:
// a finished reply, a note, a question with a recommended option, an approval, and a high-risk one.
const swatch = (fill: string, label: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="${fill}"/><text x="60" y="46" font-family="sans-serif" font-size="13" fill="#fff" text-anchor="middle">${label}</text></svg>`)}`

export function demoCards(now = Date.now()): NoticeCard[] {
  const says = (n: number): number => now - n * 1000
  const approval: Approval = {
    id: 'preview-approval',
    hash: 'preview',
    agentId: 'preview',
    conversationId: 'preview',
    messageId: 'preview',
    connectorId: 'github',
    connectorName: 'GitHub',
    tool: 'create_issue',
    args: { repo: 'acme/site', title: 'O menu some no celular' },
    why: L('Quero abrir o issue com o que achei no código.', 'I want to open the issue with what I found in the code.'),
    highRisk: false,
    state: 'pending',
    createdAt: says(30),
    expiresAt: now + 3_600_000
  }
  const question: Inbox['questions'][number] = {
    id: 'preview-ask',
    conversationId: 'preview',
    agentId: 'preview',
    text: L('Duas decisões antes de eu mexer no menu.', 'Two decisions before I touch the menu.'),
    askedTo: 'me',
    requestedBy: 'me',
    state: 'open',
    deadlineAt: now + 3_600_000,
    createdAt: says(20),
    decisions: [
      { question: L('Paginação no menu?', 'Pagination in the menu?'), kind: 'single', options: [{ label: L('Busca remota', 'Remote search'), description: L('recomendado: menos código', 'recommended: less code') }, { label: L('Scroll infinito', 'Infinite scroll') }, { label: L('Paginar', 'Paginate') }] },
      { question: L('Pra quando?', 'For when?'), kind: 'text' }
    ]
  }
  return [
    {
      id: `preview:done:${now}`,
      kind: 'done',
      at: says(5),
      preview: true,
      previewAgent: 0,
      title: L('Lia terminou', 'Lia is done'),
      body: L('Achei três coisas no menu, e **a terceira** explica o que você viu. Deixei tudo em `menu.css`.', 'I found three things in the menu, and **the third** explains what you saw. It is all in `menu.css`.'),
      agentId: 'preview',
      agentName: 'Lia',
      pictures: [
        { url: swatch('#3b9eea', 'menu'), title: 'menu.png', kind: 'image' },
        { url: swatch('#22a35a', 'diff'), title: 'diff.png', kind: 'image' },
        { url: swatch('#e3a008', 'notes'), title: 'notes.md', kind: 'text' }
      ]
    },
    {
      id: `preview:note:${now}`,
      kind: 'note',
      at: says(12),
      preview: true,
      previewAgent: 0,
      title: L('Lia mencionou você', 'Lia mentioned you'),
      body: L('“@você o deploy de sexta depende disso.”', '“@you Friday’s deploy depends on this.”'),
      agentId: 'preview',
      agentName: 'Lia'
    },
    { ...askCard(question, 'Lia'), id: `preview:ask:${now}`, at: says(20), preview: true, previewAgent: 0, agentId: 'preview', agentName: 'Lia', conversationId: undefined },
    { ...approvalCard(approval, 'Lia'), id: `preview:approval:${now}`, at: says(30), preview: true, previewAgent: 0, agentId: 'preview', agentName: 'Lia', conversationId: undefined },
    {
      ...approvalCard({ ...approval, id: 'preview-risk', tool: 'delete_branch', connectorName: 'GitHub', highRisk: true, args: { branch: 'menu' }, why: L('A branch já foi mesclada.', 'The branch is already merged.'), createdAt: says(40) }, 'Theo'),
      id: `preview:risk:${now}`,
      at: says(40),
      preview: true,
      previewAgent: 1,
      agentId: 'preview',
      agentName: 'Theo',
      conversationId: undefined
    }
  ]
}

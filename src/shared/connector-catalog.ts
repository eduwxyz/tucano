// The connectors the app offers ready to add: official remote MCP servers that an app it has never
// met (Tucano) can sign in to by itself, through the browser (OAuth with dynamic registration and
// PKCE), or that need no sign-in at all. Each was probed on 2026-11-05; a server that only takes an
// app registered ahead of time (HubSpot, Box, Asana's current one) isn't here: it's added by hand.
// Google's are the exception: its sign-in takes no app it hasn't met either, so the person registers
// one in their own Google Cloud project, once, and all of Google's connectors sign in with it.
import { L } from './lang'

export type CatalogCategory = 'google' | 'dev' | 'work' | 'business' | 'design' | 'research' | 'finance'

export interface CatalogEntry {
  id: string // also the logo's key
  name: string
  url: string
  auth: 'oauth' | 'none'
  category: CatalogCategory
  about: () => string // a few words: what the agents get
  google?: string[] // one of Google's: signs in with the person's Google app, asking for these scopes
}

export const CATEGORIES = (): { id: CatalogCategory; name: string }[] => [
  { id: 'google', name: 'Google' },
  { id: 'dev', name: L('Programação', 'Development') },
  { id: 'work', name: L('Projetos e tarefas', 'Projects and tasks') },
  { id: 'business', name: L('Negócio e dados', 'Business and data') },
  { id: 'design', name: L('Design e sites', 'Design and websites') },
  { id: 'research', name: L('Pesquisa', 'Research') },
  { id: 'finance', name: L('Finanças', 'Finance') }
]

const e = (id: string, name: string, url: string, category: CatalogCategory, pt: string, en: string, auth: CatalogEntry['auth'] = 'oauth'): CatalogEntry => ({
  id,
  name,
  url,
  auth,
  category,
  about: () => L(pt, en)
})

// Google's own MCP servers. The scopes are what their tools need, short of the full ones: Gmail
// drafts but never sends nor deletes for good, Drive reads all and writes only what it made or opened.
const DRIVE = ['drive.readonly', 'drive.file']
const g = (id: string, name: string, host: string, pt: string, en: string, scopes: string[]): CatalogEntry => ({
  ...e(id, name, `https://${host}.googleapis.com/mcp/v1`, 'google', pt, en),
  google: scopes.map((s) => `https://www.googleapis.com/auth/${s}`)
})

export const CATALOG: CatalogEntry[] = [
  g('gmail', 'Gmail', 'gmailmcp', 'E-mails, rascunhos e marcadores', 'Email, drafts and labels', ['gmail.modify']),
  g('google-calendar', 'Google Calendar', 'calendarmcp', 'Eventos, convites e horários livres', 'Events, invites and free time', ['calendar.events', 'calendar.calendarlist.readonly', 'calendar.events.freebusy']),
  g('google-drive', 'Google Drive', 'drivemcp', 'Buscar, ler e criar arquivos', 'Find, read and create files', DRIVE),
  g('google-docs', 'Google Docs', 'docsmcp', 'Ler, criar e editar documentos', 'Read, create and edit documents', [...DRIVE, 'documents']),
  g('google-sheets', 'Google Sheets', 'sheetsmcp', 'Ler, criar e editar planilhas', 'Read, create and edit spreadsheets', [...DRIVE, 'spreadsheets']),

  e('linear', 'Linear', 'https://mcp.linear.app/mcp', 'dev', 'Issues, projetos e ciclos', 'Issues, projects and cycles'),
  e('sentry', 'Sentry', 'https://mcp.sentry.dev/mcp', 'dev', 'Erros e falhas em produção', 'Errors and crashes in production'),
  e('vercel', 'Vercel', 'https://mcp.vercel.com', 'dev', 'Deploys, logs e projetos', 'Deploys, logs and projects'),
  e('cloudflare', 'Cloudflare', 'https://mcp.cloudflare.com/mcp', 'dev', 'Workers, DNS e armazenamento', 'Workers, DNS and storage'),
  e('neon', 'Neon', 'https://mcp.neon.tech/mcp', 'dev', 'Bancos Postgres, branches e migrações', 'Postgres databases, branches and migrations'),
  e('prisma', 'Prisma', 'https://mcp.prisma.io/mcp', 'dev', 'Bancos Prisma Postgres', 'Prisma Postgres databases'),
  e('netlify', 'Netlify', 'https://netlify-mcp.netlify.app/mcp', 'dev', 'Sites, deploys e logs', 'Sites, deploys and logs'),
  e('railway', 'Railway', 'https://mcp.railway.com', 'dev', 'Serviços, deploys e logs', 'Services, deploys and logs'),
  e('jam', 'Jam', 'https://mcp.jam.dev/mcp', 'dev', 'Relatos de bug com vídeo e logs', 'Bug reports with video and logs'),

  e('notion', 'Notion', 'https://mcp.notion.com/mcp', 'work', 'Páginas, bancos e documentos', 'Pages, databases and docs'),
  e('atlassian', 'Jira e Confluence', 'https://mcp.atlassian.com/v2/mcp', 'work', 'Issues do Jira e páginas do Confluence', 'Jira issues and Confluence pages'),
  e('trello', 'Trello', 'https://mcp.trello.com/v1', 'work', 'Quadros, listas e cartões', 'Boards, lists and cards'),
  e('monday', 'monday.com', 'https://mcp.monday.com/mcp', 'work', 'Quadros, itens e atualizações', 'Boards, items and updates'),
  e('clickup', 'ClickUp', 'https://mcp.clickup.com/mcp', 'work', 'Tarefas, docs e metas', 'Tasks, docs and goals'),
  e('todoist', 'Todoist', 'https://ai.todoist.net/mcp', 'work', 'Tarefas e projetos pessoais', 'Personal tasks and projects'),
  e('ticktick', 'TickTick', 'https://mcp.ticktick.com', 'work', 'Tarefas, listas e hábitos', 'Tasks, lists and habits'),
  e('granola', 'Granola', 'https://mcp.granola.ai/mcp', 'work', 'Notas das suas reuniões', 'Notes from your meetings'),

  e('posthog', 'PostHog', 'https://mcp.posthog.com/mcp', 'business', 'Análise de produto, flags e erros', 'Product analytics, flags and errors'),
  e('stripe', 'Stripe', 'https://mcp.stripe.com', 'business', 'Pagamentos, clientes e assinaturas', 'Payments, customers and subscriptions'),
  e('revenuecat', 'RevenueCat', 'https://mcp.revenuecat.ai/mcp', 'business', 'Assinaturas de apps', 'App subscriptions'),
  e('paypal', 'PayPal', 'https://mcp.paypal.com/mcp', 'business', 'Pagamentos e faturas', 'Payments and invoices'),
  e('square', 'Square', 'https://mcp.squareup.com/mcp', 'business', 'Vendas, pagamentos e estoque', 'Sales, payments and inventory'),
  e('intercom', 'Intercom', 'https://mcp.intercom.com/mcp', 'business', 'Conversas de suporte e clientes', 'Support conversations and customers'),
  e('airtable', 'Airtable', 'https://mcp.airtable.com/mcp', 'business', 'Bases e tabelas', 'Bases and tables'),
  e('zapier', 'Zapier', 'https://mcp.zapier.com/api/mcp/mcp', 'business', 'Ações em milhares de apps', 'Actions across thousands of apps'),

  e('canva', 'Canva', 'https://mcp.canva.com/mcp', 'design', 'Designs, modelos e exportações', 'Designs, templates and exports'),
  e('webflow', 'Webflow', 'https://mcp.webflow.com/mcp', 'design', 'Sites, páginas e CMS', 'Sites, pages and CMS'),
  e('wix', 'Wix', 'https://mcp.wix.com/mcp', 'design', 'Sites e lojas', 'Sites and stores'),

  e('context7', 'Context7', 'https://mcp.context7.com/mcp', 'research', 'Documentação atual de bibliotecas', 'Up-to-date library docs', 'none'),
  e('huggingface', 'Hugging Face', 'https://huggingface.co/mcp', 'research', 'Modelos, datasets e Spaces', 'Models, datasets and Spaces', 'none'),
  e('exa', 'Exa', 'https://mcp.exa.ai/mcp', 'research', 'Busca na web', 'Web search', 'none'),

  e('coinbase', 'Coinbase', 'https://agents.coinbase.com/mcp', 'finance', 'Carteira e cripto', 'Wallet and crypto'),
  e('robinhood', 'Robinhood', 'https://agent.robinhood.com/mcp/trading', 'finance', 'Ações e investimentos', 'Stocks and investments'),
  e('aave', 'Aave', 'https://mcp.aave.com/mcp', 'finance', 'Dados do protocolo Aave', 'Aave protocol data', 'none')
]

// The same server, however its address was typed: case, a trailing slash.
export const sameServer = (a: string | undefined, b: string): boolean => {
  if (!a) return false
  const norm = (u: string): string => {
    try {
      const x = new URL(u.trim())
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`
    } catch {
      return u.trim().replace(/\/+$/, '').toLowerCase()
    }
  }
  return norm(a) === norm(b)
}

// "lin" finds Linear by name; "deploy" finds Vercel by what it does.
export function searchCatalog(query: string, entries: CatalogEntry[] = CATALOG): CatalogEntry[] {
  const words = query
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return entries
  const text = (c: CatalogEntry): string => `${c.name} ${c.about()} ${CATEGORIES().find((k) => k.id === c.category)?.name ?? ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return entries.filter((c) => words.every((w) => text(c).includes(w)))
}

// The scopes a Google connector asks for, by its address; undefined for any other server.
export const googleScopes = (url: string | undefined): string[] | undefined => CATALOG.find((c) => c.google && sameServer(url, c.url))?.google

// What the person turns on in their Google Cloud project, in one page: each service's API and its MCP API.
export const GOOGLE_APIS = ['gmail', 'calendar-json', 'drive', 'docs', 'sheets'].flatMap((a) => [`${a}.googleapis.com`, `${a === 'calendar-json' ? 'calendar' : a}mcp.googleapis.com`])

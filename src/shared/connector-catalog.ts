// The connectors the app offers ready to add: official remote MCP servers that an app it has never
// met (Tucano) can sign in to by itself, through the browser (OAuth with dynamic registration and
// PKCE), or that need no sign-in at all. Each was probed on 2026-11-05 (Supabase on 2026-11-13); a server that only takes an
// app registered ahead of time (HubSpot, Box, Asana's current one; Outlook and Teams) isn't here:
// it's added by hand. Some ask a few things first (the address of your own instance, a token) or run
// the service's official server on this computer. Google's and Slack's sign-in take no app they haven't
// met either, so the person makes one, once (in Google Cloud, in their Slack workspace), and signs in
// with it.
import { L } from './lang'
import type { ConnectorInput } from './types'

export type CatalogCategory = 'google' | 'dev' | 'work' | 'business' | 'design' | 'research' | 'finance'

// Something asked before connecting. Its value fills {id} in the address, the arguments or the
// variables; the field "token" is the token itself.
export interface CatalogField {
  id: string
  label: () => string
  placeholder: string
  hint?: () => string
  secret?: boolean
  clean?: (v: string) => string // what was pasted, as it goes in (an account out of its full address)
}

export interface CatalogEntry {
  id: string // also the logo's key
  name: string
  url: string // with {field}s, filled in before connecting; empty for a local one
  auth: 'oauth' | 'none' | 'token'
  category: CatalogCategory
  about: () => string // a few words: what the agents get
  local?: { command: string; args: string[]; env?: Record<string, string> } // runs on this computer
  fields?: CatalogField[]
  app?: { provider: AppProvider; scopes: string[] } // signs in with the person's own app, asking for these scopes
  warning?: () => string // said before connecting and on its page: the data goes through someone else's servers
}

// Whose sign-in needs an app the person makes: Google's (one for its five servers) and Slack's.
export type AppProvider = 'google' | 'slack'

export const CATEGORIES = (): { id: CatalogCategory; name: string }[] => [
  { id: 'google', name: 'Google' },
  { id: 'dev', name: L('Programação', 'Development') },
  { id: 'work', name: L('Projetos e tarefas', 'Projects and tasks') },
  { id: 'business', name: L('Negócio e dados', 'Business and data') },
  { id: 'design', name: L('Design e sites', 'Design and websites') },
  { id: 'research', name: L('Pesquisa', 'Research') },
  { id: 'finance', name: L('Finanças', 'Finance') }
]

const e = (id: string, name: string, url: string, category: CatalogCategory, pt: string, en: string, auth: CatalogEntry['auth'] = 'oauth', more: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  name,
  url,
  auth,
  category,
  about: () => L(pt, en),
  ...more
})

// "https://abc.apps.dynatrace.com/…" -> "abc": the first part of a host, however much of the address was pasted.
const firstLabel = (v: string): string => v.trim().replace(/^https?:\/\//i, '').split(/[./]/)[0]!.toLowerCase()
const site = (v: string): string => {
  const t = v.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}
const plain = (v: string): string => v.trim()

const opHint = (): string => L('Ou uma referência do 1Password, como op://Cofre/Item/campo: o segredo fica lá e é lido a cada conexão.', 'Or a 1Password reference, like op://Vault/Item/field: the secret stays there and is read on each connection.')
const tokenField = (placeholder: string, hint: () => string, label = (): string => L('Token', 'Token')): CatalogField => ({
  id: 'token',
  label,
  placeholder,
  secret: true,
  clean: plain,
  hint: () => `${hint()} ${opHint()}`
})

// Google's own MCP servers. The scopes are what their tools need, short of the full ones: Gmail
// drafts but never sends nor deletes for good, Drive reads all and writes only what it made or opened.
const DRIVE = ['drive.readonly', 'drive.file']
const g = (id: string, name: string, host: string, pt: string, en: string, scopes: string[]): CatalogEntry =>
  e(id, name, `https://${host}.googleapis.com/mcp/v1`, 'google', pt, en, 'oauth', { app: { provider: 'google', scopes: scopes.map((s) => `https://www.googleapis.com/auth/${s}`) } })

// What Slack's server offers, all of it: the app is the person's, made for this, and each tool still
// goes through the classes and approvals here.
export const SLACK_SCOPES = 'canvases:read canvases:write channels:history channels:read channels:write chat:write emoji:read files:read files:write groups:history groups:read groups:write im:history im:read im:write lists:read lists:write mpim:history mpim:read mpim:write reactions:read reactions:write search:read.files search:read.im search:read.mpim search:read.private search:read.public search:read.users users:read users:read.email'.split(' ')

// The Slack app the person makes from a link, filled in: its user scopes, MCP turned on, and the
// address the sign-in comes back to, which Slack takes only as registered, port and all.
export const slackManifest = (redirectUrl: string): Record<string, unknown> => ({
  display_information: { name: 'Tucano', description: L('Os agentes do Tucano no seu Slack, pelo servidor MCP do Slack.', "Tucano's agents in your Slack, through Slack's MCP server.") },
  oauth_config: { redirect_urls: [redirectUrl], scopes: { user: SLACK_SCOPES } },
  settings: { is_mcp_enabled: true, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }
})
export const slackAppLink = (redirectUrl: string): string => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(redirectUrl)))}`

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
  e('supabase', 'Supabase', 'https://mcp.supabase.com/mcp', 'dev', 'Bancos Postgres, tabelas, migrações e Edge Functions', 'Postgres databases, tables, migrations and Edge Functions'),
  e('prisma', 'Prisma', 'https://mcp.prisma.io/mcp', 'dev', 'Bancos Prisma Postgres', 'Prisma Postgres databases'),
  e('netlify', 'Netlify', 'https://netlify-mcp.netlify.app/mcp', 'dev', 'Sites, deploys e logs', 'Sites, deploys and logs'),
  e('railway', 'Railway', 'https://mcp.railway.com', 'dev', 'Serviços, deploys e logs', 'Services, deploys and logs'),
  e('jam', 'Jam', 'https://mcp.jam.dev/mcp', 'dev', 'Relatos de bug com vídeo e logs', 'Bug reports with video and logs'),
  e('github', 'GitHub', 'https://api.githubcopilot.com/mcp/', 'dev', 'Repositórios, issues e pull requests', 'Repositories, issues and pull requests', 'token', {
    fields: [
      tokenField(
        'github_pat_…',
        () => L('Um token de acesso pessoal, de github.com/settings/personal-access-tokens, com os repositórios que os agentes podem ver.', 'A personal access token, from github.com/settings/personal-access-tokens, with the repositories the agents may see.'),
        () => L('Token de acesso pessoal', 'Personal access token')
      )
    ]
  }),
  e('azure-devops', 'Azure DevOps', '', 'dev', 'Work items, repositórios, PRs e pipelines', 'Work items, repositories, PRs and pipelines', 'none', {
    local: { command: 'npx', args: ['-y', '@azure-devops/mcp', '{organization}'] },
    fields: [
      {
        id: 'organization',
        label: () => L('Organização', 'Organization'),
        placeholder: 'contoso',
        hint: () => L('O nome em dev.azure.com/organização. Na primeira vez que um agente usar, abre o login da Microsoft no navegador.', 'The name in dev.azure.com/organization. The first time an agent uses it, the Microsoft sign-in opens in the browser.'),
        clean: (v) => {
          const t = v.trim().replace(/^https?:\/\//i, '')
          return (/^dev\.azure\.com\//i.test(t) ? t.split('/')[1]! : t.split(/[./]/)[0]!).trim()
        }
      }
    ]
  }),
  e('cloudwatch', 'AWS CloudWatch', '', 'dev', 'Métricas, alarmes e logs da AWS', 'AWS metrics, alarms and logs', 'none', {
    local: { command: 'uvx', args: ['awslabs.cloudwatch-mcp-server@latest'], env: { AWS_PROFILE: '{profile}', AWS_REGION: '{region}' } },
    fields: [
      {
        id: 'profile',
        label: () => L('Perfil da AWS', 'AWS profile'),
        placeholder: 'default',
        hint: () => L('Um perfil do ~/.aws/config, de aws configure ou aws sso login. Precisa do uv instalado (docs.astral.sh/uv).', 'A profile in ~/.aws/config, from aws configure or aws sso login. Needs uv installed (docs.astral.sh/uv).'),
        clean: plain
      },
      { id: 'region', label: () => L('Região', 'Region'), placeholder: 'us-east-1', clean: (v) => v.trim().toLowerCase() }
    ]
  }),
  e('dynatrace', 'Dynatrace', 'https://{environment}.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp', 'dev', 'Problemas, logs e métricas em produção', 'Problems, logs and metrics in production', 'token', {
    fields: [
      { id: 'environment', label: () => L('Ambiente', 'Environment'), placeholder: 'abc12345', hint: () => L('O começo do endereço: abc12345.apps.dynatrace.com.', 'The start of its address: abc12345.apps.dynatrace.com.'), clean: firstLabel },
      tokenField('dt0s16.…', () => L('Um platform token, com os escopos mcp-gateway:servers:invoke e mcp-gateway:servers:read.', 'A platform token, with the scopes mcp-gateway:servers:invoke and mcp-gateway:servers:read.'), () => 'Platform token')
    ]
  }),

  e('slack', 'Slack', 'https://mcp.slack.com/mcp', 'work', 'Mensagens, canais, canvases e listas', 'Messages, channels, canvases and lists', 'oauth', { app: { provider: 'slack', scopes: SLACK_SCOPES } }),
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
  e('snowflake', 'Snowflake', 'https://{account}.snowflakecomputing.com/api/v2/databases/{database}/schemas/{schema}/mcp-servers/{server}', 'business', 'Consultas e agentes do Cortex', 'Queries and Cortex agents', 'token', {
    fields: [
      { id: 'account', label: () => L('Conta', 'Account'), placeholder: L('minhaorg-minhaconta', 'myorg-myaccount'), hint: () => L('O começo do endereço: minhaorg-minhaconta.snowflakecomputing.com.', 'The start of its address: myorg-myaccount.snowflakecomputing.com.'), clean: firstLabel },
      { id: 'database', label: () => L('Banco', 'Database'), placeholder: 'ANALYTICS', clean: plain },
      { id: 'schema', label: () => 'Schema', placeholder: 'PUBLIC', clean: plain },
      { id: 'server', label: () => L('Servidor MCP', 'MCP server'), placeholder: 'AGENTS', hint: () => L('O nome dado em CREATE MCP SERVER.', 'The name given in CREATE MCP SERVER.'), clean: plain },
      tokenField('…', () => L('Um programmatic access token do seu usuário (ALTER USER … ADD PROGRAMMATIC ACCESS TOKEN).', 'A programmatic access token of your user (ALTER USER … ADD PROGRAMMATIC ACCESS TOKEN).'), () => 'Programmatic access token')
    ]
  }),
  e('metabase', 'Metabase', '{site}/api/metabase-mcp', 'business', 'Perguntas, dashboards e consultas', 'Questions, dashboards and queries', 'oauth', {
    fields: [
      {
        id: 'site',
        label: () => L('Endereço do seu Metabase', 'Your Metabase address'),
        placeholder: L('https://metabase.suaempresa.com', 'https://metabase.yourcompany.com'),
        hint: () => L('Com os recursos de IA ligados, em Admin → IA. O login abre no navegador.', 'With the AI features on, in Admin → AI. The sign-in opens in the browser.'),
        clean: site
      }
    ]
  }),
  e('zapier', 'Zapier', 'https://mcp.zapier.com/api/mcp/mcp', 'business', 'Ações em milhares de apps', 'Actions across thousands of apps'),
  // Composio Connect: hundreds of apps through Composio's servers, which hold the sign-in to each account
  // and see every call. It offers a handful of tools that find and run the real actions, so each run
  // asks for approval (see policy.ts).
  e('composio', 'Composio', 'https://connect.composio.dev/mcp', 'business', 'Seus dados passam pela Composio · centenas de apps sem configurar nada', 'Your data goes through Composio · hundreds of apps with nothing to set up', 'oauth', {
    warning: () =>
      L(
        'Pela Composio, seus dados passam pelos servidores dela: e-mails, planilhas e o que mais os agentes acessarem. O acesso às suas contas (Google, Notion…) fica guardado com a Composio, não no seu computador. O Tucano não controla o que ela guarda nem por quanto tempo. Se preferir que nada passe por terceiros, use os conectores diretos.',
        "Through Composio, your data goes through its servers: emails, spreadsheets and whatever else the agents reach. The access to your accounts (Google, Notion…) is kept by Composio, not on your computer. Tucano doesn't control what it keeps or for how long. If you'd rather nothing go through a third party, use the direct connectors."
      )
  }),

  e('canva', 'Canva', 'https://mcp.canva.com/mcp', 'design', 'Designs, modelos e exportações', 'Designs, templates and exports'),
  e('webflow', 'Webflow', 'https://mcp.webflow.com/mcp', 'design', 'Sites, páginas e CMS', 'Sites, pages and CMS'),
  e('wix', 'Wix', 'https://mcp.wix.com/mcp', 'design', 'Sites e lojas', 'Sites and stores'),

  e('context7', 'Context7', 'https://mcp.context7.com/mcp', 'research', 'Documentação atual de bibliotecas', 'Up-to-date library docs', 'none'),
  e('huggingface', 'Hugging Face', 'https://huggingface.co/mcp', 'research', 'Modelos, datasets e Spaces', 'Models, datasets and Spaces', 'none'),
  e('exa', 'Exa', 'https://mcp.exa.ai/mcp', 'research', 'Busca na web', 'Web search', 'none'),
  // The keyless address: /mcp serves the same tools but offers a sign-in first.
  e('keenable', 'Keenable', 'https://api.keenable.ai/mcp-public?keenable_title=tucano', 'research', 'Busca na web e páginas em Markdown', 'Web search and pages as Markdown', 'none'),

  e('coinbase', 'Coinbase', 'https://agents.coinbase.com/mcp', 'finance', 'Carteira e cripto', 'Wallet and crypto'),
  e('robinhood', 'Robinhood', 'https://agent.robinhood.com/mcp/trading', 'finance', 'Ações e investimentos', 'Stocks and investments'),
  e('aave', 'Aave', 'https://mcp.aave.com/mcp', 'finance', 'Dados do protocolo Aave', 'Aave protocol data', 'none'),
  e('mofi', 'Mofi', 'https://omofi.com.br/api/mcp', 'finance', 'Contas, cartões e gastos dos seus bancos, pelo Open Finance', 'Accounts, cards and spending from your Brazilian banks, through Open Finance')
]

// What a catalog entry adds once its fields are filled in. Throws on one left empty.
export function catalogInput(entry: CatalogEntry, values: Record<string, string> = {}): ConnectorInput {
  const filled: Record<string, string> = {}
  for (const f of entry.fields ?? []) {
    const v = (f.clean ?? plain)(values[f.id] ?? '')
    if (!v || v === 'https://') throw new Error(L(`Preencha: ${f.label()}.`, `Fill in: ${f.label()}.`))
    filled[f.id] = v
  }
  // In an address a value goes in as one piece: a "/" or "?" in it can't reach another path or server.
  const fill = (t: string, inUrl: boolean): string => t.replace(/\{(\w+)\}/g, (_, k: string) => (inUrl && k !== 'site' ? encodeURIComponent(filled[k] ?? '') : (filled[k] ?? '')))
  if (entry.local) {
    const env = Object.fromEntries(Object.entries(entry.local.env ?? {}).map(([k, v]) => [k, fill(v, false)]))
    return { name: entry.name, kind: 'stdio', command: entry.local.command, args: entry.local.args.map((a) => fill(a, false)), env }
  }
  return { name: entry.name, kind: 'remote', url: fill(entry.url, true), auth: entry.auth, ...(entry.auth === 'token' ? { token: filled['token'] } : {}) }
}

// The catalog entry a connector came from: by its address (with any {field} in it), or by the package
// its command runs.
export function entryOf(c: { kind: 'remote' | 'stdio'; url?: string; command?: string; args?: string[] }, entries: CatalogEntry[] = CATALOG): CatalogEntry | undefined {
  if (c.kind === 'stdio') return entries.find((e) => e.local && e.local.command === c.command && e.local.args.filter((a) => !a.includes('{')).every((a) => c.args?.includes(a)))
  return entries.find((e) => {
    if (e.local || !e.url) return false
    if (!e.url.includes('{')) return sameServer(c.url, e.url)
    const pattern = e.url
      .split(/\{\w+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^?#]+?')
    return new RegExp(`^${pattern}/?$`, 'i').test((c.url ?? '').trim())
  })
}

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

// Whose app a connector signs in with, and what it asks for, by its address; undefined for any other server.
export const ownAppOf = (url: string | undefined): CatalogEntry['app'] => CATALOG.find((c) => c.app && sameServer(url, c.url))?.app

// What the person turns on in their Google Cloud project, in one page: each service's API and its MCP API.
export const GOOGLE_APIS = ['gmail', 'calendar-json', 'drive', 'docs', 'sheets'].flatMap((a) => [`${a}.googleapis.com`, `${a === 'calendar-json' ? 'calendar' : a}mcp.googleapis.com`])

// ---------- the catalog as data, for a screen that doesn't have this file (the iPhone app) ----------

export interface CatalogView {
  id: string
  name: string
  category: CatalogCategory
  about: string
  auth: CatalogEntry['auth']
  fields?: { id: string; label: string; placeholder: string; hint?: string; secret?: boolean }[]
  app?: AppProvider // signs in with the person's own app (ownAppGuide)
  warning?: string
  runs?: string // a server of the service's that runs on the Tucano's machine: its command
}

export function catalogView(entries: CatalogEntry[] = CATALOG): CatalogView[] {
  return entries.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    about: c.about(),
    auth: c.auth,
    ...(c.fields?.length ? { fields: c.fields.map((f) => ({ id: f.id, label: f.label(), placeholder: f.placeholder, ...(f.hint ? { hint: f.hint() } : {}), ...(f.secret ? { secret: true } : {}) })) } : {}),
    ...(c.app ? { app: c.app.provider } : {}),
    ...(c.warning ? { warning: c.warning() } : {}),
    ...(c.local ? { runs: [c.local.command, ...c.local.args.filter((a) => !a.includes('{'))].join(' ') } : {})
  }))
}

// The person's own app, step by step (Google and Slack sign in only apps registered with them; see
// OwnAppSetup): what the desktop's window and the phone's sheet both say.
export interface OwnAppGuide {
  title: string
  lead: string
  steps: { text: string; link?: string; linkText?: string }[] // linkText opens link, then text follows
  idLabel: string
  idPlaceholder: string
  secretLabel: string
  secretPlaceholder: string
  notes: string[]
}

const cloud = (path: string): string => `https://console.cloud.google.com/${path}`

export function ownAppGuide(provider: AppProvider, redirectUrl: string): OwnAppGuide {
  if (provider === 'slack')
    return {
      title: L('Seu app do Slack', 'Your Slack app'),
      lead: L(
        'O Slack só deixa usar o servidor MCP dele apps do diretório ou apps internos de um workspace. Você cria o seu, interno, em uns 2 minutos: o link já traz tudo preenchido. Os dados vão do Slack direto pro seu Tucano.',
        "Slack lets only directory apps or a workspace's internal apps use its MCP server. You make yours, internal, in about 2 minutes: the link brings it all filled in. The data goes from Slack straight to your Tucano."
      ),
      steps: [
        { link: slackAppLink(redirectUrl), linkText: L('Crie o app no Slack', 'Create the app in Slack'), text: L(': escolha o seu workspace, clique em Próximo e em Criar. O nome, as permissões, o endereço de volta e o MCP já vêm preenchidos.', ': choose your workspace, click Next and Create. The name, the permissions, the return address and MCP come filled in.') },
        { text: L('Em Basic Information › App Credentials, copie o Client ID e o Client Secret (Show) e cole aqui:', 'Under Basic Information › App Credentials, copy the Client ID and the Client Secret (Show) and paste them here:') }
      ],
      idLabel: 'Client ID',
      idPlaceholder: '1234567890.1234567890123',
      secretLabel: 'Client Secret',
      secretPlaceholder: '',
      notes: [L('Num workspace de empresa, o admin pode precisar aprovar o app antes: o Slack avisa no login, e o pedido vai pra ele.', 'In a company workspace, an admin may need to approve the app first: Slack says so at sign-in, and the request goes to them.')]
    }
  return {
    title: L('Seu app do Google', 'Your Google app'),
    lead: L(
      'O Google só deixa entrar apps cadastrados nele. Você cria o seu uma vez, em uns 10 minutos, e o Gmail, o Drive, o Calendar, o Docs e o Sheets entram com ele. Fica tudo na sua conta: os dados vão do Google direto pro seu Tucano.',
      'Google only lets in apps registered with it. You make yours once, in about 10 minutes, and Gmail, Drive, Calendar, Docs and Sheets sign in with it. It all stays in your account: the data goes from Google straight to your Tucano.'
    ),
    steps: [
      { link: cloud('projectcreate'), linkText: L('Crie um projeto no Google Cloud', 'Create a project in Google Cloud'), text: L(', com o nome que quiser (Tucano, por exemplo).', ', named as you like (Tucano, say).') },
      { link: cloud(`flows/enableapi?apiid=${GOOGLE_APIS.join(',')}`), linkText: L('Ative as APIs', 'Turn on the APIs'), text: L(': com o projeto escolhido no topo, clique em Próxima e em Ativar. São as do Gmail, Drive, Calendar, Docs e Sheets e a MCP de cada um.', ': with the project chosen at the top, click Next and Enable. They are Gmail, Drive, Calendar, Docs and Sheets, and the MCP one of each.') },
      {
        link: 'https://developers.google.com/workspace/preview',
        linkText: L('Inscreva o projeto no Developer Preview', 'Enroll the project in the Developer Preview'),
        text: L(
          ': os servidores MCP do Google ainda estão em prévia e só atendem projetos inscritos no Google Workspace Developer Preview Program. O formulário pede o número do projeto (no painel do projeto). A aprovação costuma levar uns dias: siga os passos e salve, mas até lá os conectores do Google falham.',
          ": Google's MCP servers are still in preview and only serve projects enrolled in the Google Workspace Developer Preview Program. The form asks for the project number (on the project's dashboard). Approval usually takes a couple of days: go on with the steps and save, but until then the Google connectors fail."
        )
      },
      {
        link: cloud('auth/overview'),
        linkText: L('Configure a tela de login', 'Set up the sign-in screen'),
        text: L(
          ' (Google Auth Platform › Começar): o nome do app e o seu e-mail; em Público-alvo, Externo (ou Interno, numa conta Google Workspace de empresa). Depois, em Público-alvo › Usuários de teste, adicione o seu e-mail.',
          ' (Google Auth Platform › Get started): the app name and your email; under Audience, External (or Internal, in a company Google Workspace account). Then, under Audience › Test users, add your email.'
        )
      },
      {
        link: cloud('auth/clients/create'),
        linkText: L('Crie o cliente', 'Create the client'),
        text: L(': em Tipo de aplicativo, App para computador; marque “Usar este cliente para um agente com IA” (sem isso o Google recusa os conectores) e clique em Criar.', ': under Application type, Desktop app; tick “Use this client for an AI-powered agent” (without it Google turns the connectors away) and click Create.')
      },
      { text: L('Copie o ID do cliente e a chave secreta do cliente que aparecem e cole aqui:', 'Copy the client ID and the client secret it shows and paste them here:') }
    ],
    idLabel: L('ID do cliente', 'Client ID'),
    idPlaceholder: '1234567890-abc….apps.googleusercontent.com',
    secretLabel: L('Chave secreta do cliente', 'Client secret'),
    secretPlaceholder: 'GOCSPX-…',
    notes: [
      L(
        'Com o app em teste, o Google pede pra entrar de novo a cada 7 dias. Pra não pedir, em Público-alvo clique em Publicar app: no login vai aparecer “O Google não verificou este app”. É o seu próprio app: clique em Avançado e continue.',
        'While the app is in testing, Google asks you to sign in again every 7 days. To stop that, click Publish app under Audience: the sign-in will say “Google hasn’t verified this app”. It’s your own app: click Advanced and go on.'
      ),
      L('Prefere não configurar? A Composio, na loja, conecta o Google sem isso, mas seus dados passam pelos servidores dela.', "Rather not set this up? Composio, in the store, connects Google without it, but your data goes through its servers.")
    ]
  }
}

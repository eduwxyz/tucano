// Meta's official WhatsApp Cloud API: plain HTTPS calls to the Graph API, plus the three things
// the webhook needs (the handshake, the signature check and reading what Meta sends). Nothing
// here keeps state: the service holds the keys and calls these.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import type { WhatsAppTemplate } from '../../shared/whatsapp'

const GRAPH = 'https://graph.facebook.com/v23.0'
const TIMEOUT_MS = 15_000

export interface CloudCreds {
  phoneId: string
  wabaId: string
  token: string
  appSecret: string
}

// What Meta delivered: one text a person wrote to the number.
export interface CloudIncoming {
  phoneId: string
  from: string // their number, digits only
  name: string // the name on their profile, when Meta sends it
  id: string
  at: number
  text: string
}

// What stands in for a message that has no text, for the agent and for the person reading.
export function placeholder(kind: 'image' | 'audio' | 'sticker' | 'document' | 'video' | 'location' | 'contact'): string {
  switch (kind) {
    case 'image':
      return L('[imagem]', '[image]')
    case 'audio':
      return L('[áudio]', '[audio]')
    case 'sticker':
      return L('[figurinha]', '[sticker]')
    case 'document':
      return L('[documento]', '[document]')
    case 'video':
      return L('[vídeo]', '[video]')
    case 'location':
      return L('[localização]', '[location]')
    case 'contact':
      return L('[contato]', '[contact]')
  }
}

// ---------- Meta's answers, in words ----------

interface MetaError {
  error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string; error_data?: { details?: string } }
}

// Meta's refusal as a sentence that says what to do next.
export function metaError(status: number, body: unknown): UserError {
  const e = (body as MetaError | null)?.error
  const code = e?.code
  const sub = e?.error_subcode
  const detail = e?.error_data?.details ?? e?.error_user_msg ?? e?.message
  if (code === 190 || status === 401)
    return new UserError(L('A chave de acesso da Meta venceu ou foi trocada. Gere uma nova no painel da Meta e cole de novo.', "Meta's access token expired or was replaced. Make a new one in Meta's panel and paste it again."))
  if (code === 131047 || code === 131051)
    return new UserError(L('Já passou 24 horas desde a última mensagem dessa pessoa: a Meta só deixa mandar um modelo aprovado. Use um modelo.', "It's been over 24 hours since that person's last message: Meta only allows an approved template now. Use a template."))
  if (code === 131026)
    return new UserError(L('Esse número não está no WhatsApp (ou não pode receber mensagens agora).', "That number isn't on WhatsApp (or can't receive messages right now)."))
  if (code === 131030)
    return new UserError(L('Esse número não está na lista de testes da Meta. Adicione-o no painel da Meta ou use um número em produção.', "That number isn't on Meta's test list. Add it in Meta's panel or use a number in production."))
  if (code === 130429 || code === 131048 || code === 131056 || code === 80007 || status === 429)
    return new UserError(L('A Meta pediu pra ir mais devagar (limite de envios). Tente de novo daqui a pouco.', 'Meta asked to slow down (sending limit). Try again in a little while.'))
  if (code === 132001 || sub === 2494073)
    return new UserError(L('Esse modelo não existe, ou não existe nesse idioma. Confira o nome e o idioma na lista de modelos.', "That template doesn't exist, or not in that language. Check the name and language in the template list."))
  if (code === 132000 || code === 132005 || code === 132012)
    return new UserError(L('As variáveis não batem com o modelo. Confira quantas ele pede.', "The variables don't match the template. Check how many it asks for."))
  if (code === 131042)
    return new UserError(L('A Meta recusou por um problema de pagamento da conta. Veja o painel da Meta.', "Meta refused because of a payment problem on the account. Check Meta's panel."))
  if (code === 100 || status === 404)
    return new UserError(L('A Meta não achou esse número. Confira o "ID do número de telefone" e o "ID da conta do WhatsApp Business".', 'Meta could not find that number. Check the "Phone number ID" and the "WhatsApp Business Account ID".'))
  if (code === 10 || code === 200 || status === 403)
    return new UserError(L('A chave de acesso não tem permissão pra isso. Gere uma com acesso ao WhatsApp no painel da Meta.', "The access token isn't allowed to do that. Make one with WhatsApp access in Meta's panel."))
  return new UserError(L(`A Meta recusou${detail ? `: ${detail}` : '.'}`, `Meta refused${detail ? `: ${detail}` : '.'}`))
}

async function graph(path: string, token: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${GRAPH}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw new UserError(L('Não consegui falar com a Meta. Confira a internet e tente de novo.', "I couldn't reach Meta. Check the internet and try again."))
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw metaError(res.status, body)
  return body
}

const idPart = (v: string): string => encodeURIComponent(v)

// The number's display phone (as Meta shows it), proving the id and the token belong together.
export async function check(phoneId: string, token: string): Promise<{ phone: string; name?: string }> {
  const body = (await graph(`/${idPart(phoneId)}?fields=display_phone_number,verified_name`, token)) as { display_phone_number?: string; verified_name?: string } | null
  if (!body?.display_phone_number) throw new UserError(L('A Meta não devolveu o telefone desse número. Confira o "ID do número de telefone".', 'Meta did not return that number\'s phone. Check the "Phone number ID".'))
  return { phone: body.display_phone_number, ...(body.verified_name ? { name: body.verified_name } : {}) }
}

const sentId = (body: unknown): string => {
  const id = (body as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id
  if (!id) throw new UserError(L('A Meta não confirmou o envio. Veja se a mensagem chegou antes de tentar de novo.', "Meta didn't confirm the send. Check whether the message arrived before trying again."))
  return id
}

export async function sendText(c: CloudCreds, to: string, text: string): Promise<string> {
  return sentId(await graph(`/${idPart(c.phoneId)}/messages`, c.token, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: false } } }))
}

export async function sendTemplate(c: CloudCreds, to: string, name: string, language: string, variables: string[]): Promise<string> {
  const components = variables.length ? [{ type: 'body', parameters: variables.map((text) => ({ type: 'text', text })) }] : []
  return sentId(
    await graph(`/${idPart(c.phoneId)}/messages`, c.token, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name, language: { code: language }, components } }
    })
  )
}

interface TemplateRow {
  name?: string
  language?: string
  status?: string
  components?: { type?: string; text?: string }[]
}

// The approved templates of the business account: the only ones that can be sent.
export async function templates(c: CloudCreds): Promise<WhatsAppTemplate[]> {
  const out: WhatsAppTemplate[] = []
  let path: string | undefined = `/${idPart(c.wabaId)}/message_templates?fields=name,language,status,components&limit=100`
  for (let page = 0; path && page < 5; page++) {
    const body = (await graph(path, c.token)) as { data?: TemplateRow[]; paging?: { next?: string } } | null
    for (const t of body?.data ?? []) {
      if (t.status !== 'APPROVED' || !t.name || !t.language) continue
      const text = t.components?.find((x) => x.type === 'BODY')?.text ?? ''
      const variables = [...text.matchAll(/\{\{(\d+)\}\}/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0)
      out.push({ name: t.name, language: t.language, body: text, variables })
    }
    // Meta's next link is a full address; only its path and query are followed, with our own host.
    const next = body?.paging?.next
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') || undefined : undefined
    if (path && !path.startsWith('/')) path = undefined
  }
  return out
}

// ---------- the webhook ----------

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// Meta's GET handshake when the address is saved in its panel: echoes the challenge only for our token.
export function verify(query: Record<string, string>, token: string): { status: number; body: string } {
  const mode = query['hub.mode'] ?? ''
  const given = query['hub.verify_token'] ?? ''
  const challenge = query['hub.challenge'] ?? ''
  // The challenge is a number in practice; anything else is not echoed back (it would be reflected text).
  if (mode === 'subscribe' && token && safeEqual(given, token) && /^[\w-]{1,200}$/.test(challenge)) return { status: 200, body: challenge }
  return { status: 403, body: 'forbidden' }
}

// `X-Hub-Signature-256: sha256=<hmac of the raw body with the app secret>`.
export function signed(appSecret: string, rawBody: string, signature: string | undefined): boolean {
  if (!appSecret || !signature) return false
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim())
  if (!match) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  return safeEqual(expected, match[1]!.toLowerCase())
}

interface WebhookMessage {
  from?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  image?: { caption?: string }
  video?: { caption?: string }
  document?: { caption?: string; filename?: string }
  button?: { text?: string }
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
}

function textOf(m: WebhookMessage): string | undefined {
  const caption = (label: string, c: string | undefined): string => (c ? `${label} ${c}` : label)
  switch (m.type) {
    case 'text':
      return m.text?.body
    case 'image':
      return caption(placeholder('image'), m.image?.caption)
    case 'video':
      return caption(placeholder('video'), m.video?.caption)
    case 'document':
      return caption(placeholder('document'), m.document?.caption ?? m.document?.filename)
    case 'audio':
      return placeholder('audio')
    case 'sticker':
      return placeholder('sticker')
    case 'location':
      return placeholder('location')
    case 'contacts':
      return placeholder('contact')
    case 'button':
      return m.button?.text
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
    default:
      return undefined // reactions, system notices and kinds not known yet
  }
}

// Every message in a webhook body; whatever is shaped differently is skipped, never an error.
export function parse(body: unknown): CloudIncoming[] {
  const out: CloudIncoming[] = []
  const entries = (body as { entry?: unknown } | null)?.entry
  if (!Array.isArray(entries)) return out
  for (const entry of entries as { changes?: unknown }[]) {
    if (!Array.isArray(entry?.changes)) continue
    for (const change of entry.changes as { value?: { metadata?: { phone_number_id?: string }; contacts?: { wa_id?: string; profile?: { name?: string } }[]; messages?: WebhookMessage[] } }[]) {
      const v = change?.value
      const phoneId = v?.metadata?.phone_number_id
      if (!phoneId || !Array.isArray(v?.messages)) continue
      for (const m of v.messages) {
        const text = textOf(m ?? {})
        if (!m?.from || !m.id || text === undefined) continue
        const secs = Number(m.timestamp)
        out.push({
          phoneId,
          from: m.from.replace(/\D/g, ''),
          name: v.contacts?.find((c) => c?.wa_id === m.from)?.profile?.name ?? '',
          id: m.id,
          at: Number.isFinite(secs) && secs > 0 ? secs * 1000 : Date.now(),
          text
        })
      }
    }
  }
  return out
}

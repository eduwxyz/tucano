// Meta's official WhatsApp Cloud API: plain HTTPS calls to the Graph API, plus the three things
// the webhook needs (the handshake, the signature check and reading what Meta sends). Nothing
// here keeps state: the service holds the keys and calls these.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { MEDIA_IN_MAX, MEDIA_OUT_MAX, type WhatsAppMediaKind, type WhatsAppTemplate } from '../../shared/whatsapp'

const GRAPH = 'https://graph.facebook.com/v23.0'
const TIMEOUT_MS = 15_000
const FILE_TIMEOUT_MS = 60_000 // a file goes up or comes down slower than a text
// Where Meta keeps the files people send. The token is only ever shown to these hosts.
const MEDIA_HOSTS = ['fbsbx.com', 'facebook.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com']

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
  media?: { kind: WhatsAppMediaKind; mime: string; id: string; fileName?: string; caption?: string } // `id` is Meta's media id: `download` turns it into the bytes
  quotedId?: string // the message this one answers (Meta's id)
}

// Something that happened to a message that already exists (today: a reaction, or its removal with an empty emoji).
// Apart from `parse` so a reaction is never taken for a message someone wrote.
export interface CloudChange {
  phoneId: string
  from: string
  id: string // the reaction's own id
  at: number
  kind: 'reaction'
  target: string // the message reacted to
  emoji: string
}

// What stands in for a message that has no text, for the agent and for the person reading.
export function placeholder(kind: 'image' | 'audio' | 'sticker' | 'document' | 'video' | 'location' | 'contact' | 'poll'): string {
  switch (kind) {
    case 'poll':
      return L('[enquete]', '[poll]')
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
  if (code === 131052 || code === 131053)
    return new UserError(L('A Meta não aceitou esse arquivo (tipo ou tamanho não permitido). Tente outro formato ou um arquivo menor.', "Meta didn't accept that file (type or size not allowed). Try another format or a smaller file."))
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

// `form` is a file upload: fetch sets its own content type (with the boundary).
async function graph(path: string, token: string, init: { method?: 'GET' | 'POST'; body?: unknown; form?: FormData; timeoutMs?: number } = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${GRAPH}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : init.form ? { body: init.form } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS)
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

// `replyTo` is the id of the message being answered: Meta shows it quoted.
export async function sendText(c: CloudCreds, to: string, text: string, replyTo?: string): Promise<string> {
  return sentId(
    await graph(`/${idPart(c.phoneId)}/messages`, c.token, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: false }, ...(replyTo ? { context: { message_id: replyTo } } : {}) }
    })
  )
}

// Puts a file in Meta's storage and returns its media id (what `sendMedia` sends).
export async function upload(c: CloudCreds, data: Buffer, mime: string, name: string): Promise<string> {
  if (data.length === 0) throw new UserError(L('Esse arquivo está vazio.', 'That file is empty.'))
  if (data.length > MEDIA_OUT_MAX) throw new UserError(L(`O arquivo passa de ${Math.round(MEDIA_OUT_MAX / 1048576)} MB, o máximo para enviar.`, `The file is over ${Math.round(MEDIA_OUT_MAX / 1048576)} MB, the most that can be sent.`))
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mime)
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), name.replace(/[\r\n"]/g, '_').slice(0, 120) || 'file')
  const id = ((await graph(`/${idPart(c.phoneId)}/media`, c.token, { method: 'POST', form, timeoutMs: FILE_TIMEOUT_MS })) as { id?: string } | null)?.id
  if (!id) throw new UserError(L('A Meta não confirmou o recebimento do arquivo. Tente de novo.', "Meta didn't confirm it received the file. Try again."))
  return id
}

// A caption only exists for image, video and document; a file name only for a document (Meta refuses them elsewhere).
export async function sendMedia(c: CloudCreds, to: string, kind: 'image' | 'audio' | 'document' | 'video', mediaId: string, caption?: string, fileName?: string, replyTo?: string): Promise<string> {
  const file = { id: mediaId, ...(caption && kind !== 'audio' ? { caption } : {}), ...(fileName && kind === 'document' ? { filename: fileName } : {}) }
  return sentId(
    await graph(`/${idPart(c.phoneId)}/messages`, c.token, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: file, ...(replyTo ? { context: { message_id: replyTo } } : {}) }
    })
  )
}

// An empty emoji takes the reaction back.
export async function react(c: CloudCreds, to: string, messageId: string, emoji: string): Promise<string> {
  return sentId(await graph(`/${idPart(c.phoneId)}/messages`, c.token, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'reaction', reaction: { message_id: messageId, emoji } } }))
}

// The blue ticks, for a message they wrote.
export async function markRead(c: CloudCreds, messageId: string): Promise<void> {
  await graph(`/${idPart(c.phoneId)}/messages`, c.token, { method: 'POST', body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId } })
}

const tooBig = (): UserError => new UserError(L(`O arquivo passa de ${Math.round(MEDIA_IN_MAX / 1048576)} MB e não foi guardado.`, `The file is over ${Math.round(MEDIA_IN_MAX / 1048576)} MB and was not kept.`))

// A file someone sent: Meta gives an address for the media id, and the file is fetched from there with the token.
export async function download(c: CloudCreds, mediaId: string): Promise<{ data: Buffer; mime: string }> {
  const meta = (await graph(`/${idPart(mediaId)}`, c.token)) as { url?: string; mime_type?: string; file_size?: number } | null
  if (typeof meta?.file_size === 'number' && meta.file_size > MEDIA_IN_MAX) throw tooBig()
  let url: URL
  try {
    url = new URL(meta?.url ?? '')
  } catch {
    throw new UserError(L('A Meta não deu o endereço desse arquivo. Ele pode ter expirado.', "Meta didn't give that file's address. It may have expired."))
  }
  // Only Meta's own storage ever sees the token.
  if (url.protocol !== 'https:' || !MEDIA_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`)))
    throw new UserError(L('A Meta apontou um endereço de arquivo desconhecido; por segurança não baixei.', 'Meta pointed to an unknown file address; for safety I did not download it.'))
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
    if (!res.ok) throw new UserError(L('Não consegui baixar esse arquivo da Meta. Ele pode ter expirado.', "I couldn't download that file from Meta. It may have expired."))
    if (Number(res.headers.get('content-length')) > MEDIA_IN_MAX) throw tooBig()
    // Counted as it arrives: a missing or wrong length can't make a huge file land in memory.
    const parts: Buffer[] = []
    let total = 0
    const reader = res.body?.getReader()
    if (!reader) throw new UserError(L('Não consegui baixar esse arquivo da Meta.', "I couldn't download that file from Meta."))
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MEDIA_IN_MAX) {
        void reader.cancel().catch(() => {})
        throw tooBig()
      }
      parts.push(Buffer.from(value))
    }
    return { data: Buffer.concat(parts), mime: meta?.mime_type || res.headers.get('content-type') || 'application/octet-stream' }
  } catch (e) {
    if (e instanceof UserError) throw e
    throw new UserError(L('Não consegui baixar esse arquivo da Meta. Confira a internet e tente de novo.', "I couldn't download that file from Meta. Check the internet and try again."))
  }
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

interface MediaPart {
  id?: string
  mime_type?: string
  caption?: string
}

interface WebhookMessage {
  from?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  image?: MediaPart
  video?: MediaPart
  audio?: MediaPart
  sticker?: MediaPart
  document?: MediaPart & { filename?: string }
  context?: { id?: string }
  reaction?: { message_id?: string; emoji?: string }
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

const DEFAULT_MIME: Record<WhatsAppMediaKind, string> = { image: 'image/jpeg', audio: 'audio/ogg', video: 'video/mp4', document: 'application/octet-stream', sticker: 'image/webp' }

// The file a message carries, when it has one Meta can hand over.
function mediaOf(m: WebhookMessage): CloudIncoming['media'] {
  const kind = m.type === 'image' || m.type === 'video' || m.type === 'audio' || m.type === 'document' || m.type === 'sticker' ? m.type : undefined
  const part = kind ? m[kind] : undefined
  if (!kind || !part?.id || typeof part.id !== 'string') return undefined
  const fileName = kind === 'document' ? (m.document?.filename ?? '').split(/[\\/]/).pop()?.replace(/\p{Cc}/gu, '').trim().slice(0, 120) : undefined
  const caption = typeof part.caption === 'string' ? part.caption.trim() : ''
  return { kind, mime: typeof part.mime_type === 'string' && part.mime_type ? part.mime_type : DEFAULT_MIME[kind], id: part.id, ...(fileName ? { fileName } : {}), ...(caption ? { caption } : {}) }
}

type Hook = { value?: { metadata?: { phone_number_id?: string }; contacts?: { wa_id?: string; profile?: { name?: string } }[]; messages?: WebhookMessage[] } }

// Every message of a webhook body, with the entry it came in; whatever is shaped differently is skipped, never an error.
function eachMessage(body: unknown, fn: (m: WebhookMessage & { from: string; id: string }, phoneId: string, name: string, at: number) => void): void {
  const entries = (body as { entry?: unknown } | null)?.entry
  if (!Array.isArray(entries)) return
  for (const entry of entries as { changes?: unknown }[]) {
    if (!Array.isArray(entry?.changes)) continue
    for (const change of entry.changes as Hook[]) {
      const v = change?.value
      const phoneId = v?.metadata?.phone_number_id
      if (!phoneId || !Array.isArray(v?.messages)) continue
      for (const m of v.messages) {
        if (!m || typeof m.from !== 'string' || typeof m.id !== 'string') continue
        const secs = Number(m.timestamp)
        fn(m as WebhookMessage & { from: string; id: string }, phoneId, v.contacts?.find((c) => c?.wa_id === m.from)?.profile?.name ?? '', Number.isFinite(secs) && secs > 0 ? secs * 1000 : Date.now())
      }
    }
  }
}

// Every message someone wrote (reactions are in `parseChanges`).
export function parse(body: unknown): CloudIncoming[] {
  const out: CloudIncoming[] = []
  eachMessage(body, (m, phoneId, name, at) => {
    const text = textOf(m)
    if (text === undefined) return
    const media = mediaOf(m)
    const quotedId = typeof m.context?.id === 'string' && m.context.id ? m.context.id : undefined
    out.push({ phoneId, from: m.from.replace(/\D/g, ''), name, id: m.id, at, text, ...(media ? { media } : {}), ...(quotedId ? { quotedId } : {}) })
  })
  return out
}

// Reactions that arrived (an empty emoji is one taken back).
export function parseChanges(body: unknown): CloudChange[] {
  const out: CloudChange[] = []
  eachMessage(body, (m, phoneId, _name, at) => {
    if (m.type !== 'reaction' || typeof m.reaction?.message_id !== 'string' || !m.reaction.message_id) return
    out.push({ phoneId, from: m.from.replace(/\D/g, ''), id: m.id, at, kind: 'reaction', target: m.reaction.message_id, emoji: typeof m.reaction.emoji === 'string' ? m.reaction.emoji : '' })
  })
  return out
}

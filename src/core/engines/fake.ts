import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { L } from '../../shared/lang'
import { memorySystem } from '../memory'
import { curatorSystem } from '../wiki-curator'
import { handoffSystem, routerSystem } from '../router'
import type { Engine, EngineEvent, Turn } from './types'

// Deterministic engine for tests and screenshots. Never spawns anything, but
// behaves like the real ones where it matters: it routes when given the
// router prompt, and calls ask_user through the gateway when asked to ask.
// `sessions`: it takes kept sessions like Claude Code does, and `released` gets the ones let go;
// `warmed` gets what was started ahead ("warm <model>", "rewarm <session id>").
export function fakeEngine(id: Engine['id'], opts: { delayMs?: number; reply?: (turn: Turn) => string; sessions?: boolean; released?: string[]; warmed?: string[] } = {}): Engine {
  const delay = opts.delayMs ?? 25
  return {
    id,
    ...(id === 'codex' ? { planUsage: async () => ({ windows: [{ minutes: 300, utilization: 0.12, resetsAt: Date.now() + 3 * 3_600_000 }, { minutes: 10_080, utilization: 0.09, resetsAt: Date.now() + 5 * 86_400_000 }], plan: 'plus', at: Date.now() }) } : {}),
    ...(opts.sessions
      ? {
          sessions: true,
          release: (sessionId: string) => void opts.released?.push(sessionId),
          warm: (t: { model: string }) => void opts.warmed?.push(`warm ${t.model}`),
          rewarm: (sessionId: string) => void opts.warmed?.push(`rewarm ${sessionId}`)
        }
      : {}),
    async *run(turn): AsyncIterable<EngineEvent> {
      let last = lastMessage(turn.prompt)
      // Work handed down (src/core/delegations.ts): what was asked is the line after "um pedido:", and
      // what came back to whoever asked is in the task at the end, not in a message.
      const handed = /A mensagem acima é um pedido de|The message above is a request from/.test(turn.prompt) ? [...turn.prompt.matchAll(/(?:um pedido|a request):\n\n([^\n]+)/g)].at(-1)?.[1] : undefined
      if (handed) last = handed
      const back = /(?:Voltou do que você pediu ao seu time|Back from what you asked of your team):[\s\S]*$/.exec(turn.prompt)?.[0]
      // "acabou o limite": Claude's usual login is out, to see an agent's reserve take over (another
      // harness, or another account of Claude, whose limit is still there).
      if (id === 'claude' && !turn.account && /acabou o limite|out of quota/i.test(last) && turn.system !== routerSystem() && turn.system !== handoffSystem() && turn.system !== memorySystem()) {
        yield { type: 'error', message: "You've hit your limit · resets 5pm" }
        return
      }
      let reply: string
      let spend = 0 // "gaste N tokens": a reply that costs that much, to see the budget pause
      if (turn.system === routerSystem()) {
        reply = JSON.stringify(fakeRoute(turn.prompt))
      } else if (turn.system === handoffSystem()) {
        reply = JSON.stringify(fakeHandoff(turn.prompt))
      } else if (turn.system === memorySystem()) {
        reply = JSON.stringify(fakeConsolidation(turn.prompt))
      } else if (turn.system === curatorSystem()) {
        reply = JSON.stringify(fakeCuration(turn.prompt))
      } else if (opts.reply) {
        reply = opts.reply(turn)
      } else if (turn.mcpUrl && (`${turn.system}\n${turn.prompt}`.includes('## Pra montar agentes') || `${turn.system}\n${turn.prompt}`.includes('## For building agents'))) {
        // The Tuca: asks once, then proposes a support agent. A migration: everything at once, in one
        // reply (a new agent, a change to each of the seed's, a routine and a channel that need the new one).
        if (/migra/i.test(last)) {
          const calls: [string, Record<string, unknown>][] = [
            ['propor_agente', { nome: 'Léo', funcao: L('Financeiro', 'Finance'), cor: 'amber', instrucoes: L('Você cuida das contas do time.\nLê os gastos do dia e separa por categoria.\nResponde em tópicos curtos.\nNunca paga nada: pergunta antes.', "You look after the team's accounts.\nRead the day's expenses and sort them by category.\nAnswer in short bullet points.\nNever pay anything: ask first."), esforco: 'low', web: false, motivo: L('Alguém só pras contas.', 'Someone just for the accounts.') }],
            ...['lia', 'theo', 'nina'].map((agente): [string, Record<string, unknown>] => ['propor_ajuste', { agente, limite: 345_000, motivo: L('Migração: o limite novo do time.', "Migration: the team's new limit.") }]),
            ['propor_rotina', { agente: 'Léo', nome: L('Fechamento do dia', 'Daily close'), pedido: L('Resuma os gastos do dia.', "Sum up the day's expenses."), dias: [1, 2, 3, 4, 5], hora: '18:00' }],
            ['propor_canal', { nome: L('financeiro', 'finance'), agentes: ['nina', 'Léo'], tema: L('Contas e fechamento', 'Accounts and closing') }]
          ]
          for (const [tool, args] of calls) await callTool(turn.mcpUrl, tool, args)
          reply = L('Mandei tudo de uma vez: o Léo, o limite novo de cada um, a rotina dele e o canal. Dá pra aplicar um por um ou todos.', 'I sent it all at once: Léo, the new limit for each, his routine and the channel. You can apply them one by one or all together.')
        } else if (/suporte|ticket|cliente|support|customer/i.test(last)) {
          const r = await callTool(turn.mcpUrl, 'propor_agente', {
            nome: 'Rafa',
            funcao: L('Suporte', 'Support'),
            cor: 'green',
            instrucoes: L(
              'Você tria os tickets de suporte que chegam e rascunha as respostas.\nLê o ticket inteiro antes, separa bug de dúvida e marca a urgência.\nResponde em tom gentil e direto, sem jargão, em até 5 linhas.\nNunca promete prazo nem reembolso: nesses casos, pergunta antes.',
              'You triage incoming support tickets and draft the replies.\nRead the whole ticket first, tell bugs from questions and mark the urgency.\nAnswer in a kind, direct tone, no jargon, in up to 5 lines.\nNever promise a deadline or a refund: in those cases, ask first.'
            ),
            esforco: 'medium',
            web: false,
            primeira_tarefa: L('Me mostra como você responderia um cliente que não consegue entrar na conta.', "Show me how you'd answer a customer who can't sign in."),
            motivo: L('Um agente só pra triagem e rascunho, sem poder enviar nada sozinho.', 'An agent just for triage and drafts, unable to send anything on its own.')
          })
          reply = textOf(r).includes('card') ? L('Montei o Rafa. Dá pra criar, editar antes ou me pedir ajustes.', 'I put Rafa together. You can create it, edit it first or ask me for changes.') : textOf(r)
        } else reply = L('Legal! Que tipo de tarefa você quer delegar? Me dá um exemplo de algo que você fez essa semana.', 'Nice! What kind of task do you want to delegate? Give me an example of something you did this week.')
      } else if (turn.mcpUrl && back) {
        // What came back from its team: a question left there is answered ("responda a dúvida com `x`", in
        // what the person wrote first) or taken to the person; an end is told in a line.
        const waiting = /\[([0-9a-f]{8})\][^\n]*(?:deixou uma pergunta|left a question)/.exec(back)
        const known = /respond[ae] (?:a d[úu]vida|the question) com `([^`]+)`/i.exec(turn.prompt)
        if (waiting && known) {
          await callTool(turn.mcpUrl, 'responder_pedido', { id: waiting[1]!, resposta: known[1]! })
          reply = 'Respondi a dúvida dele.'
        } else if (waiting) {
          await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
          reply = 'Ele precisa de uma decisão sua.'
        } else reply = /passou do prazo|past its deadline/.test(back) ? 'Passou do prazo e ainda não terminou.' : /: não terminou|did not finish/.test(back) ? 'Não deu certo: o pedido não terminou.' : 'Pronto: o time terminou o que pedi.'
      } else if (turn.mcpUrl && /(?:delegue|hand) (?:a|à|ao|pr[ao]|to) @?([\w-]+)(?: (?:em|in) #([\w-]+))?: ([^\n]+)/i.test(last)) {
        // "delegue a clara: responda o Fulano" (several lines: several requests), "delegue a clara em #vendas: …".
        const out: string[] = []
        for (const m of last.matchAll(/(?:delegue|hand) (?:a|à|ao|pr[ao]|to) @?([\w-]+)(?: (?:em|in) #([\w-]+))?: ([^\n]+)/gi)) out.push(textOf(await callTool(turn.mcpUrl, 'pedir', { para: m[1]!, pedido: m[3]!, ...(m[2] ? { canal: m[2] } : {}), ...(/prazo de (\d+) ?h/i.test(m[3]!) ? { prazo_horas: Number(/prazo de (\d+) ?h/i.exec(m[3]!)![1]) } : {}) })))
        reply = out.join('\n')
      } else if (turn.mcpUrl && /^repasse: (.+)/i.test(last)) {
        // The person's answer to a question that came up from the team, passed on to whoever waits for it.
        const code = /\[([0-9a-f]{8})\][^\n]*(?:esperando uma resposta sua|waiting for an answer from you)/.exec(turn.prompt)?.[1] ?? ''
        reply = textOf(await callTool(turn.mcpUrl, 'responder_pedido', { id: code, resposta: /^repasse: (.+)/i.exec(last)![1]! }))
      } else if (turn.mcpUrl && /cancele o pedido/i.test(last)) {
        const code = [...turn.prompt.matchAll(/\[([0-9a-f]{8})\]/g)].at(-1)?.[1] ?? ''
        reply = textOf(await callTool(turn.mcpUrl, 'cancelar_pedido', { id: code, motivo: 'mudou o plano' }))
      } else if (/pe[çc]a pr[oa] (\w+)/i.test(last)) {
        reply = `@${/pe[çc]a pr[oa] (\w+)/i.exec(last)![1]!.toLowerCase()}, pode ajudar aqui?`
      } else if (/agrade[çc]a (?:a|ao|à) (\w+)/i.test(last)) {
        // A thank-you that mentions someone: the hand-off screening lets no one answer it.
        reply = `Valeu, @${/agrade[çc]a (?:a|ao|à) (\w+)/i.exec(last)![1]!.toLowerCase()}! Ficou ótimo.`
      } else if (turn.mcpUrl && /(lista|liste|mostra|quais).*tarefas/i.test(last)) {
        const r = await callTool(turn.mcpUrl, await toolNamed(turn.mcpUrl, 'list_tasks'), {})
        reply = `Suas tarefas:\n\n${textOf(r)}`
      } else if (turn.mcpUrl && /apag\w* a tarefa (\d+)/i.test(last)) {
        const id = Number(/apag\w* a tarefa (\d+)/i.exec(last)![1])
        await callTool(turn.mcpUrl, await toolNamed(turn.mcpUrl, 'delete_task'), { id, _motivo: 'Você pediu pra apagar.' })
        reply = `Pedi sua aprovação pra apagar a tarefa #${id}.`
      } else if (turn.mcpUrl && /(?:consulte|run the sql) `([^`]+)`/i.test(last)) {
        // A SQL connector's tool (Databricks' execute_sql_read_only), to see its steps and errors.
        const statement = /(?:consulte|run the sql) `([^`]+)`/i.exec(last)![1]!
        const r = await callTool(turn.mcpUrl, await toolNamed(turn.mcpUrl, 'execute_sql_read_only'), { statement })
        reply = textOf(r)
      } else if (turn.mcpUrl && /com a skill ([\w-]+),? rode `([^`]+)`(?: e depois `([^`]+)`)?/is.test(last)) {
        // A skill that runs a CLI (a databricks-query skill and the databricks command): read it, then run.
        const [, skill, first, then] = /com a skill ([\w-]+),? rode `([^`]+)`(?: e depois `([^`]+)`)?/is.exec(last)!
        await callTool(turn.mcpUrl, 'ler_skill', { nome: skill })
        for (const command of [first!, then].filter(Boolean)) await callTool(turn.mcpUrl, 'bash', { command })
        reply = L(
          'Rodei o SQL pela skill: Sudeste lidera, depois Sul e Nordeste. O segundo comando falhou: o token foi recusado.',
          'I ran the SQL through the skill: Southeast leads, then South and Northeast. The second command failed: the token was refused.'
        )
      } else if (turn.mcpUrl && /rode `([^`]+)`/i.test(last)) {
        const r = await callTool(turn.mcpUrl, 'bash', { command: /rode `([^`]+)`/i.exec(last)![1]! })
        reply = `Saída:\n\n${textOf(r)}`
      } else if (turn.mcpUrl && /suba `([^`]+)` na porta (\d+)/i.test(last)) {
        const [, command, port] = /suba `([^`]+)` na porta (\d+)/i.exec(last)!
        const r = await callTool(turn.mcpUrl, 'start_service', { name: 'app', command, port: Number(port) })
        reply = textOf(r)
      } else if (turn.mcpUrl && /mostre `([^`]+)`/i.test(last)) {
        const r = await callTool(turn.mcpUrl, 'show_file', { path: /mostre `([^`]+)`/i.exec(last)![1]! })
        reply = textOf(r)
      } else if (turn.mcpUrl && /print de (\S+)/i.test(last)) {
        const r = await callTool(turn.mcpUrl, 'screenshot', { url: /print de (\S+)/i.exec(last)![1]! })
        reply = textOf(r)
      } else if (turn.mcpUrl && /agend\w* `([^`]+)`(?: em (\d{4}-\d{2}-\d{2}))? às (\d{1,2}:\d{2})( uma vez)?: (.+)/i.test(last)) {
        const [, nome, data, horario, once, pedido] = /agend\w* `([^`]+)`(?: em (\d{4}-\d{2}-\d{2}))? às (\d{1,2}:\d{2})( uma vez)?: (.+)/i.exec(last)!
        const r = await callTool(turn.mcpUrl, 'agendar_rotina', { nome, horario, pedido, uma_vez: !!once, ...(data ? { data } : {}) })
        reply = textOf(r)
      } else if (turn.mcpUrl && /proponha a skill `([^`]+)` \(quando: ([^)]+)\): (.+)/is.test(last)) {
        const [, nome, quando_usar, receita] = /proponha a skill `([^`]+)` \(quando: ([^)]+)\): (.+)/is.exec(last)!
        const r = await callTool(turn.mcpUrl, 'propor_skill', { nome, quando_usar, receita, motivo: 'Faço isso sempre do mesmo jeito.' })
        reply = textOf(r)
      } else if (/gaste (\d+) tokens/i.test(last)) {
        spend = Number(/gaste (\d+) tokens/i.exec(last)![1])
        reply = 'Instalei o Swift e li o módulo de sorteio. Falta rodar os testes do Core e conferir o filtro de questões recentes.'
      } else if (turn.mcpUrl && /lembr[ae] que (.+)/i.test(last)) {
        const texto = /lembr[ae] que (.+)/i.exec(last)![1]!.trim()
        await callTool(turn.mcpUrl, 'lembrar', { texto, sobre: 'usuario' })
        reply = 'Anotado.'
      } else if (turn.mcpUrl && /pergunte em (\d+) ?s/i.test(last)) {
        // "pergunte em 3 s": asks after a delay, so a test can leave the thread while it's still working.
        await new Promise((r) => setTimeout(r, Number(/pergunte em (\d+) ?s/i.exec(last)![1]) * 1000))
        await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
        reply = 'Te mandei uma pergunta.'
      } else if (/decis(õ|o)es demais/i.test(last) && turn.mcpUrl) {
        await callTool(turn.mcpUrl, 'ask_user', { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Decisão ${i + 1}?`, kind: 'text' })) })
        reply = 'Tentei perguntar demais.'
      } else if (/ajuda a decidir|decida com/i.test(last) && turn.mcpUrl) {
        // "me ajuda a decidir": decisions with options. "decida com a Bia": the same, to someone in
        // particular (a Tucano with people). Not any "decidimos", which other tests say as a fact.
        const para = /decida com (?:a |o )?(\p{L}+)/iu.exec(last)?.[1]
        const r = await callTool(turn.mcpUrl, 'ask_user', {
          questions: [
            { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] },
            { question: 'Pra quando?', kind: 'text' }
          ],
          ...(para ? { para } : {})
        })
        reply = textOf(r).includes('autorizar') || textOf(r).includes('allow') ? 'Vou perguntar se deixarem.' : 'Te mandei duas decisões.'
      } else if (turn.mcpUrl && /pergunte (?:a|à|pra|para) (\p{L}+)/iu.test(last)) {
        // "pergunte a Bia": a question to someone in particular (a Tucano with people).
        const r = await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?', para: /pergunte (?:a|à|pra|para) (\p{L}+)/iu.exec(last)![1]! })
        reply = textOf(r).includes('autorizar') || textOf(r).includes('allow') ? 'Vou perguntar se deixarem.' : 'Mandei a pergunta.'
      } else if (/pergunt/i.test(last) && turn.mcpUrl) {
        await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
        reply = 'Te mandei uma pergunta.'
      } else {
        reply = `Resposta de teste (${id} · ${turn.model}). Recebi ${turn.prompt.length} caracteres de contexto.`
      }

      const inputTokens = Math.ceil((turn.system.length + turn.prompt.length) / 4)
      yield { type: 'progress', tokens: inputTokens + spend }
      // "demore 8 s": a reply that takes its time, to see one at work.
      const slow = /^\s*(?:delegue|hand) /i.test(last) ? null : /demore (\d+) ?s/i.exec(last) // what it hands down is the other's to take its time on
      if (slow) await new Promise((r) => setTimeout(r, Number(slow[1]) * 1000))
      if (id === 'claude') yield { type: 'quota', quota: { fiveHour: { utilization: 0.34, resetsAt: Date.now() + 2 * 3_600_000 }, sevenDay: { utilization: 0.21, resetsAt: Date.now() + 4 * 86_400_000 }, at: Date.now() } }
      let text = ''
      for (const word of reply.split(/(\s+)/)) {
        if (turn.signal.aborted) return
        await new Promise((r) => setTimeout(r, delay))
        text += word
        yield { type: 'text', delta: word }
      }
      const outputTokens = Math.ceil(reply.length / 4)
      yield {
        type: 'done',
        text,
        usage: { inputTokens, cacheReadTokens: 0, outputTokens, apiCostUsd: id === 'claude' ? 0.001 : undefined }
      }
    }
  }
}

// The text of the last message in a transcript or router prompt.
function lastMessage(prompt: string): string {
  const blocks = prompt.split(/\n\n|\n(?=\[)/).filter((b) => b.startsWith('['))
  return blocks.at(-1)?.replace(/^\[[^\]]*\]\s*/, '') ?? ''
}

const ROLE_WORDS: [RegExp, RegExp][] = [
  [/engenharia/i, /build|bug|erro|código|deploy|teste|pr\b/i],
  [/dados/i, /métrica|dados|sql|média|mediana|quantos|receita/i],
  [/conteúdo/i, /post|texto|anúncio|linkedin|escrev/i]
]

function fakeRoute(prompt: string): { handles: string[]; reason: string } {
  const last = lastMessage(prompt)
  if (/^(bom dia|boa tarde|boa noite|obrigad|valeu|ok)\b/i.test(last.trim())) return { handles: [], reason: 'cumprimento, ninguém precisa responder' }
  const roster = [...prompt.matchAll(/^- ([a-z0-9_-]+): ([^·\n]*)/gim)].map((m) => ({ handle: m[1]!, about: m[2]! }))
  // A short yes goes to the agent whose message above ended in a question (the router's rule).
  if (/^(pode|sim|manda|yes|go ahead)\b/i.test(last.trim())) {
    const asker = [...prompt.slice(0, prompt.lastIndexOf(last)).matchAll(/\[([^\]]+)\] [^\n]*\?(?= →|$)/gm)].map((m) => roster.find((r) => r.about.startsWith(`${m[1]!},`) || r.about.trim() === m[1]))
    const who = asker.filter(Boolean).at(-1)
    if (who) return { handles: [who.handle], reason: 'respondeu à pergunta dele' }
  }
  const fit = roster.find((r) => ROLE_WORDS.some(([role, words]) => role.test(r.about) && words.test(last)))
  const pick = fit ?? roster[0]
  return pick ? { handles: [pick.handle], reason: fit ? 'assunto da área dele' : 'primeiro do canal' } : { handles: [], reason: 'sem agentes' }
}

// Courtesy replies don't hand the turn; anything else does, to every mentioned agent.
function fakeHandoff(prompt: string): { handles: string[]; reason: string } {
  const [head = '', rest = ''] = prompt.split('<reply>\n')
  const reply = rest.slice(0, rest.lastIndexOf('\n</reply>'))
  const body = reply.replace(/^(?:@[\w-]+|[\s,.!:;-])+/, '')
  if (!body.includes('?') && /^(valeu|obrigad|combinado|ok\b|beleza|👍|thanks|got it|fico esperando|aguardo)/i.test(body)) return { handles: [], reason: 'agradecimento, ninguém precisa responder' }
  return { handles: [...head.matchAll(/^- ([a-z0-9_-]+): /gim)].map((m) => m[1]!), reason: 'pedido' }
}

// Summarizes by listing the first words of each message, and learns "prefiro X"
// from any author: the memory module must drop what an agent said.
function fakeConsolidation(prompt: string): { summary: string; memories: { op: string; text: string; evidence: number[] }[] } {
  const lines = [...prompt.matchAll(/^\((\d+)\) \[[^\]]*\] (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2]! }))
  const previous = /^Resumo atual:\n(.*)$/m.exec(prompt)?.[1]
  const summary = [previous && previous !== '(ainda não há)' && previous !== '(none yet)' ? previous : '', `Resumo de teste: ${lines.map((l) => l.text.slice(0, 20)).join(' | ')}`].filter(Boolean).join(' / ')
  const memories = lines.flatMap((l) => {
    const m = /prefiro (.+)/i.exec(l.text)
    return m ? [{ op: 'add', text: `Prefere ${m[1]!.trim()}`, evidence: [l.n] }] : []
  })
  return { summary, memories }
}

const textOf = (r: unknown): string => ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n')

// The gateway prefixes tools with the connector name; find one by its own name.
async function toolNamed(url: string, suffix: string): Promise<string> {
  const client = new Client({ name: 'fake-engine', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  try {
    return (await client.listTools()).tools.find((t) => t.name.endsWith(`__${suffix}`))?.name ?? suffix
  } finally {
    await client.close()
  }
}

export async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: 'fake-engine', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  try {
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close()
  }
}

// The wiki's curator, for trying it without an engine: a page the stretch names gets a line
// under History; a stretch with numbers or a decision becomes a page of its own.
function fakeCuration(prompt: string): { guardar: boolean; motivo: string; titulo_fonte: string; mudancas: Record<string, string>[] } {
  const stretch = prompt.split(/\n## [^\n]*(?:Trecho|Stretch)[^\n]*\n/)[1]?.split('\n\nResponda')[0]?.split('\n\nReply')[0] ?? ''
  const titles = [...prompt.matchAll(/^- \[\[([^\]]+)\]\]/gm)].map((m) => m[1]!)
  const named = titles.find((t) => t.toLowerCase().split(/\s+/).filter((w) => w.length >= 5).some((w) => stretch.toLowerCase().includes(w)))
  const plain = stretch.replace(/\*\*[^*]+\*\* \([^)]*\): /g, '').replace(/\s+/g, ' ').trim()
  const line = plain.length > 160 ? `${plain.slice(0, 157)}…` : plain
  const day = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  const mudancas: Record<string, string>[] = []
  if (named) mudancas.push({ op: 'append', pagina: named, secao: L('Histórico', 'History'), texto: `- **${day}:** ${line}` })
  if (/\d|decid|fech|guarda/i.test(plain) && !named) mudancas.push({ op: 'create', pagina: plain.split(/[.!?:]/)[0]!.split(' ').slice(0, 5).join(' '), tipo: L('Assunto', 'Topic'), texto: `${line}\n\n## ${L('Detalhes', 'Details')}\n- ${line}` })
  return { guardar: mudancas.length > 0, motivo: L('Um fato que vale lembrar.', 'A fact worth remembering.'), titulo_fonte: plain.split(/[.!?]/)[0]!.slice(0, 60) || L('Trecho de conversa', 'Conversation excerpt'), mudancas }
}

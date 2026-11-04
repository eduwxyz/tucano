import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { L } from '../../shared/lang'
import { memorySystem } from '../memory'
import { curatorSystem } from '../wiki-curator'
import { routerSystem } from '../router'
import type { Engine, EngineEvent, Turn } from './types'

// Deterministic engine for tests and screenshots. Never spawns anything, but
// behaves like the real ones where it matters: it routes when given the
// router prompt, and calls ask_user through the gateway when asked to ask.
export function fakeEngine(id: Engine['id'], opts: { delayMs?: number; reply?: (turn: Turn) => string } = {}): Engine {
  const delay = opts.delayMs ?? 25
  return {
    id,
    async *run(turn): AsyncIterable<EngineEvent> {
      const last = lastMessage(turn.prompt)
      // "acabou o limite": Claude's usual login is out, to see an agent's reserve take over (another
      // harness, or another account of Claude, whose limit is still there).
      if (id === 'claude' && !turn.account && /acabou o limite|out of quota/i.test(last) && turn.system !== routerSystem() && turn.system !== memorySystem()) {
        yield { type: 'error', message: "You've hit your limit · resets 5pm" }
        return
      }
      let reply: string
      let spend = 0 // "gaste N tokens": a reply that costs that much, to see the budget pause
      if (turn.system === routerSystem()) {
        reply = JSON.stringify(fakeRoute(turn.prompt))
      } else if (turn.system === memorySystem()) {
        reply = JSON.stringify(fakeConsolidation(turn.prompt))
      } else if (turn.system === curatorSystem()) {
        reply = JSON.stringify(fakeCuration(turn.prompt))
      } else if (opts.reply) {
        reply = opts.reply(turn)
      } else if (turn.mcpUrl && (turn.system.includes('## Pra montar agentes') || turn.system.includes('## For building agents'))) {
        // The Tuca: asks once, then proposes a support agent.
        if (/suporte|ticket|cliente|support|customer/i.test(last)) {
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
      } else if (CAME_BACK.test(turn.prompt) && !delegatedTask(turn.prompt)) {
        // A manager with its team's results: sums them up.
        reply = fakeReport(turn.prompt)
      } else if (delegatedTask(turn.prompt) !== undefined) {
        // A delegate: "pergunte" in its task asks once; anything else is done right away.
        const task = delegatedTask(turn.prompt)!
        if (turn.mcpUrl && (DELEGUE.test(task) || CHAME.test(task)) && !CAME_BACK.test(turn.prompt)) reply = await delegateAll(turn.mcpUrl, task)
        else if (CAME_BACK.test(turn.prompt)) reply = L(`Feito, com a ajuda: ${task.slice(0, 120)}`, `Done, with the help: ${task.slice(0, 120)}`)
        // "rode `git push`" in its task: runs it once; back after a decision on it, it reports.
        else if (turn.mcpUrl && /rode `([^`]+)`/i.test(task) && !/(aprovou|recusou|não respondeu ao pedido pra) rodar|(approved|turned down|the request for) running/i.test(turn.prompt)) {
          const r = textOf(await callTool(turn.mcpUrl, 'bash', { command: /rode `([^`]+)`/i.exec(task)![1]! }))
          reply = /NÃO rodou|has NOT run/.test(r) ? L('Pedi aprovação pra rodar o comando.', 'I asked for approval to run the command.') : r
        }
        else if (turn.mcpUrl && /pergunt|ask/i.test(task) && !/ferramenta ask_user|ask_user tool/.test(turn.prompt)) {
          await callTool(turn.mcpUrl, 'ask_user', { question: L('Pra quando você precisa disso?', 'When do you need this by?') })
          reply = L('Te mandei uma pergunta.', 'I sent you a question.')
        } else reply = L(`Feito: ${task.slice(0, 120)}`, `Done: ${task.slice(0, 120)}`)
      } else if (turn.mcpUrl && ASK_AROUND.test(last) && !CAME_BACK.test(turn.prompt)) {
        const [, canal, pergunta] = ASK_AROUND.exec(last)!
        const r = (await callTool(turn.mcpUrl, 'pedir_ajuda', { canal: canal!, pergunta: pergunta!.trim() })) as { isError?: boolean }
        reply = r.isError ? textOf(r) : L(`Perguntei em #${canal}. A resposta volta aqui.`, `I asked in #${canal}. The answer comes back here.`)
      } else if (turn.mcpUrl && (DELEGUE.test(last) || CHAME.test(last))) {
        reply = await delegateAll(turn.mcpUrl, last)
      } else if (/pe[çc]a pr[oa] (\w+)/i.test(last)) {
        reply = `@${/pe[çc]a pr[oa] (\w+)/i.exec(last)![1]!.toLowerCase()}, pode ajudar aqui?`
      } else if (turn.mcpUrl && /(lista|liste|mostra|quais).*tarefas/i.test(last)) {
        const r = await callTool(turn.mcpUrl, await toolNamed(turn.mcpUrl, 'list_tasks'), {})
        reply = `Suas tarefas:\n\n${textOf(r)}`
      } else if (turn.mcpUrl && /apag\w* a tarefa (\d+)/i.test(last)) {
        const id = Number(/apag\w* a tarefa (\d+)/i.exec(last)![1])
        await callTool(turn.mcpUrl, await toolNamed(turn.mcpUrl, 'delete_task'), { id, _motivo: 'Você pediu pra apagar.' })
        reply = `Pedi sua aprovação pra apagar a tarefa #${id}.`
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
      } else if (turn.mcpUrl && /agend\w* `([^`]+)` às (\d{1,2}:\d{2})( uma vez)?: (.+)/i.test(last)) {
        const [, nome, horario, once, pedido] = /agend\w* `([^`]+)` às (\d{1,2}:\d{2})( uma vez)?: (.+)/i.exec(last)!
        const r = await callTool(turn.mcpUrl, 'agendar_rotina', { nome, horario, pedido, uma_vez: !!once })
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
      } else if (/pergunt/i.test(last) && turn.mcpUrl) {
        await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
        reply = 'Te mandei uma pergunta.'
      } else {
        reply = `Resposta de teste (${id} · ${turn.model}). Recebi ${turn.prompt.length} caracteres de contexto.`
      }

      const inputTokens = Math.ceil((turn.system.length + turn.prompt.length) / 4)
      yield { type: 'progress', tokens: inputTokens + spend }
      // "demore 8 s": a reply that takes its time, to see one at work.
      const slow = /demore (\d+) ?s/i.exec(last)
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

// "delegue a @dev: X; chame @ana: Y": one task each, through the gateway's delegar.
const DELEGUE = /delegue (?:a|ao|à|pra|pro|para|to) @[\w-]/i
const CHAME = /chame @[\w-]/i
// "pergunte em #dados: qual a mediana?": the question goes to the channel, through pedir_ajuda.
const ASK_AROUND = /pergunte em #([\w-]+):\s*(.+)/i
const CAME_BACK = /Voltou o que você delegou|What you delegated is back/
async function delegateAll(url: string, text: string): Promise<string> {
  const sent: string[] = []
  for (const m of text.matchAll(/(delegue (?:a|ao|à|pra|pro|para|to)|chame) @([\w-]+):?\s*([^;\n]+)/gi)) {
    const r = (await callTool(url, 'delegar', { agente: m[2]!, tarefa: m[3]!.trim() })) as { isError?: boolean }
    // A refusal names the handle with @: said back without it, so it calls no one.
    sent.push(r.isError ? `${m[2]} (${textOf(r).replace(/@/g, '')})` : m[2]!)
  }
  return L(`Mandei pra equipe: ${sent.join(', ')}. Os resultados voltam aqui.`, `Sent to the team: ${sent.join(', ')}. The results come back here.`)
}

// A lead's report from the results it got back: each one's line, with the reply it wrote elsewhere.
function fakeReport(prompt: string): string {
  const items = [...prompt.matchAll(/^- (.+?) \(@[\w-]+\) (.+?)\. (?:Tarefa|Pedido|Task|Request): (.+)$(?:\n(?:Resposta|Reply):\n<(?:resposta|reply)>\n([\s\S]*?)\n<\/(?:resposta|reply)>)?/gm)]
  const done = items.every((m) => /terminou|finished/.test(m[2]!))
  const lines = items.map((m) => `- **${m[1]}** · ${m[3]}: ${m[4]?.trim() || m[2]}`)
  return L(
    [`**Resultado:** ${done ? 'pronto, a equipe fez tudo o que você pediu.' : 'parte ficou faltando, abaixo.'}`, '**Quem fez o quê**', ...lines, '**Decidido:** segui o que cada um entregou, sem mudanças.', '**Aplicado:** nada fora desta conversa; são respostas, nenhum arquivo ou sistema foi mexido.', `**Pendências:** ${done ? 'nenhuma.' : 'as tarefas que não terminaram.'}`].join('\n\n'),
    [`**Result:** ${done ? 'done, the team did everything you asked.' : 'part of it is missing, below.'}`, '**Who did what**', ...lines, '**Decided:** I went with what each one delivered, unchanged.', '**Applied:** nothing outside this conversation; these are replies, no file or system was touched.', `**Left:** ${done ? 'nothing.' : "the tasks that didn't finish."}`].join('\n\n')
  )
}

// The task a delegate was handed, when this turn works on one.
function delegatedTask(prompt: string): string | undefined {
  return /<(?:tarefa|task)>\n([\s\S]*?)\n<\/(?:tarefa|task)>/.exec(prompt)?.[1]
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
  const fit = roster.find((r) => ROLE_WORDS.some(([role, words]) => role.test(r.about) && words.test(last)))
  const pick = fit ?? roster[0]
  return pick ? { handles: [pick.handle], reason: fit ? 'assunto da área dele' : 'primeiro do canal' } : { handles: [], reason: 'sem agentes' }
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

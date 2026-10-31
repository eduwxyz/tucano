import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { L } from '../../shared/lang'
import { memorySystem } from '../memory'
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
      let reply: string
      let spend = 0 // "gaste N tokens": a reply that costs that much, to see the budget pause
      if (turn.system === routerSystem()) {
        reply = JSON.stringify(fakeRoute(turn.prompt))
      } else if (turn.system === memorySystem()) {
        reply = JSON.stringify(fakeConsolidation(turn.prompt))
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

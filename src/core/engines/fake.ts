import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { L, locale } from '../../shared/lang'
import { memorySystem } from '../memory'
import { titleSystem } from '../titles'
import { shortTitle } from '../../shared/titles'
import { curatorSystem } from '../wiki-curator'
import { answerSystem, catalogSystem } from '../docs-brain'
import { chimeSystem, handoffSystem, routerSystem } from '../router'
import type { Engine, EngineEvent, Turn } from './types'

// What makes a reply hand work on, continue a request or pass an answer on (see each branch below).
const HANDS = /(?:delegue|hand) (?:a|à|ao|pr[ao]|to) @?[\w-]+(?: (?:em|in) #[\w-]+)?: [^\n]+|^continue (?:com|with) @?[\w-]+: .+|^repasse: .+/im

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
      const handed = /A mensagem acima é (?:um pedido d[eo]|de) |The message above is (?:a request )?from /.test(turn.prompt) ? [...turn.prompt.matchAll(/(?:um pedido|a request):\n\n([^\n]+)/g)].at(-1)?.[1] : undefined
      if (handed) last = handed
      const back = /(?:Voltou do que você pediu ao seu time|Back from what you asked of your team):[\s\S]*$/.exec(turn.prompt)?.[0]
      // "acabou o limite": Claude's usual login is out, to see an agent's reserve take over (another
      // harness, or another account of Claude, whose limit is still there).
      if (id === 'claude' && !turn.account && /acabou o limite|out of quota/i.test(last) && turn.system !== routerSystem() && turn.system !== handoffSystem() && turn.system !== chimeSystem() && turn.system !== memorySystem()) {
        yield { type: 'error', message: "You've hit your limit · resets 5pm" }
        return
      }
      // "quebre de vez", in work handed to it: the reply fails on something that doesn't pass by itself, to
      // see what whoever asked does with a part that did not get done.
      if (handed && /quebre de vez|break for good/i.test(handed)) {
        yield { type: 'error', message: L('quebrou', 'it broke') }
        return
      }
      let reply: string
      let spend = 0 // "gaste N tokens": a reply that costs that much, to see the budget pause
      if (turn.system === routerSystem()) {
        reply = JSON.stringify(fakeRoute(turn.prompt))
      } else if (turn.system === handoffSystem()) {
        reply = JSON.stringify(fakeHandoff(turn.prompt))
      } else if (turn.system === chimeSystem()) {
        // Someone is called in only when the reply says so, as "[entra rev]" (with no @, which would be a
        // mention and hand the turn on by itself): otherwise no one.
        const reply_ = /<reply>[\s\S]*?<\/reply>/.exec(turn.prompt)?.[0] ?? ''
        const h = /\[entra @?([\w-]+)\]/.exec(reply_)?.[1]
        reply = JSON.stringify({ handle: h ?? null, reason: h ? L('é da área dele', 'it is their area') : '' })
      } else if (turn.system === memorySystem()) {
        reply = JSON.stringify(fakeConsolidation(turn.prompt))
      } else if (turn.system === titleSystem()) {
        // A request's title: its own words, short (the real one is a cheap model's).
        reply = shortTitle(turn.prompt.split('\n').filter((l) => !/^(?:demore|pergunte|delegue|me ajuda a decidir)/i.test(l.trim())).join('\n'), 40)
      } else if (turn.system === curatorSystem()) {
        reply = JSON.stringify(fakeCuration(turn.prompt))
      } else if (turn.system === catalogSystem()) {
        reply = JSON.stringify(fakeCatalog(turn.prompt))
      } else if (turn.system === answerSystem()) {
        reply = JSON.stringify(fakeAnswer(turn.prompt))
      } else if (opts.reply) {
        reply = opts.reply(turn)
      } else if (turn.mcpUrl && !back && !HANDS.test(last) && (`${turn.system}\n${turn.prompt}`.includes('## Pra montar agentes') || `${turn.system}\n${turn.prompt}`.includes('## For building agents'))) {
        // The Tuca: asks once, then proposes a support agent. A migration: everything at once, in one
        // reply (a new agent, a change to each of the seed's, a routine and a channel that need the new one).
        // What he hands to the team, and what comes back from it, goes as any agent's does, further down.
        // What the person answered on the card where he asked leave to do something himself: told to him
        // as this reply's task, at the very end of the prompt.
        const after = turn.prompt.slice(Math.max(0, turn.prompt.lastIndexOf(last)))
        const let_ = /(?:deixou você fazer isto você mesmo|let you do this yourself)[^:]*: "([^"]+)"/.exec(after)
        const rather = /(?:prefere um colega pra isso|would rather have a colleague for this)[^"]*"([^"]+)"/.exec(after)
        const waits = /(?:prefere esperar|would rather wait for) ([^.]+)\./.exec(after)
        if (waits) {
          reply = L(`Combinado, fica com ${waits[1]}. É só me pedir de novo quando estiver resolvido.`, `Agreed, it stays with ${waits[1]}. Just ask me again once it is sorted out.`)
        } else if (let_) {
          // With leave: he does it, and suggests a colleague when told the kind of thing keeps coming back.
          const again = /next_steps[^"]*"([^"]+)"/.exec(after)
          if (again) await callTool(turn.mcpUrl, 'next_steps', { steps: [{ label: again[1]! }] })
          reply = L(`Pronto, fiz eu mesmo: ${let_[1]}`, `Done, I did it myself: ${let_[1]}`)
        } else if (rather) {
          const r = await callTool(turn.mcpUrl, 'propor_agente', { nome: 'Caio', funcao: L('Pesquisa', 'Research'), cor: 'green', instrucoes: L(`Você cuida disto: ${rather[1]}\nEntrega curto, com as fontes.\nPergunta só o que impede de seguir.`, `You take care of this: ${rather[1]}\nDeliver short, with sources.\nAsk only what keeps you from going on.`), esforco: 'low', web: true })
          reply = textOf(r).includes('card') || /Anotado|Noted/.test(textOf(r)) ? L('Montei o Caio pra isso. Criado, eu passo o pedido a ele.', 'I put Caio together for this. Once made, I pass the request to them.') : textOf(r)
        } else if (/^fa[çc]a voc[êe](?: \(([^)]*)\))?: (.+)/im.test(last)) {
          // "faça você (pesquisa de preços, web, +Linear): pesquisar os preços": he asks leave to do it himself,
          // naming the kind of thing, the web and the connectors (with a +) he would use. "no lugar de Theo":
          // in the place of a colleague, which only holds for one who did not finish.
          const [, how = '', what] = /^fa[çc]a voc[êe](?: \(([^)]*)\))?: (.+)/im.exec(last)!
          const parts = how.split(',').map((x) => x.trim()).filter(Boolean)
          const place = parts.find((x) => /^(?:no lugar de|in place of) /i.test(x))
          const told = textOf(await callTool(turn.mcpUrl, 'fazer_eu_mesmo', { ...(place ? { no_lugar_de: place.replace(/^(?:no lugar de|in place of) /i, '') } : {}), o_que: what!, tipo: parts.find((x) => x !== 'web' && !x.startsWith('+') && x !== place) ?? what!.slice(0, 40), web: parts.includes('web'), conectores: parts.filter((x) => x.startsWith('+')).map((x) => ({ conector: x.slice(1).replace(/!$/, ''), ...(x.endsWith('!') ? { nivel: 'escrita' } : {}) })) }))
          const again = /next_steps[^"]*"([^"]+)"/.exec(told)
          if (again) await callTool(turn.mcpUrl, 'next_steps', { steps: [{ label: again[1]! }] })
          reply = /^(?:Liberado|Allowed)/.test(told) ? L(`Pronto, fiz eu mesmo: ${what}`, `Done, I did it myself: ${what}`) : /^(?:Pergunta enviada|Question sent)/.test(told) ? L('Ninguém do time faz isso ainda.', 'No one on the team does this yet.') : told
        } else if (/(?:mande|send) (?:um |a )?feedback: (.+)/i.test(last)) {
          // "mande um feedback: …": he writes it as a card for the person to review and send.
          const texto = /(?:mande|send) (?:um |a )?feedback: (.+)/i.exec(last)![1]!.trim()
          const r = await callTool(turn.mcpUrl, 'propor_feedback', { tipo: /bug|erro|quebr/i.test(texto) ? 'bug' : 'idea', texto })
          reply = textOf(r).includes('card') ? L('Escrevi o feedback no card: revise e envie por ele.', 'I wrote the feedback on the card: review it and send it from there.') : textOf(r)
        } else if (/time de conte[uú]do/i.test(last)) {
          // A team with a channel, one of them with a connector to write to, and a routine for the other.
          const each = (nome: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ nome, funcao: L('Conteúdo', 'Content'), cor: 'violet', instrucoes: L(`Você é ${nome}.\nCuida do conteúdo do time.\nResponde curto.`, `You are ${nome}.\nLook after the team's content.\nAnswer briefly.`), esforco: 'low', web: false, ...extra })
          await callTool(turn.mcpUrl, 'propor_time', { agentes: [each('Escriba', { conectores: [{ conector: 'Planilha', nivel: 'escrita' }] }), each('Revisora')], canal: { nome: L('redacao', 'writing'), tema: L('Posts da semana', "The week's posts") } })
          await callTool(turn.mcpUrl, 'propor_rotina', { agente: 'Revisora', nome: L('Revisão da manhã', 'Morning review'), pedido: L('Revise os posts do dia.', "Review the day's posts."), dias: [1, 2, 3, 4, 5], hora: '09:00' })
          reply = L('Criei o time de conteúdo. Dá pra desfazer no card.', 'I made the content team. It can be undone on the card.')
        } else if (/mais esperta/i.test(last)) {
          // A change with a part inside the app (effort) and a part that spends money (the month's limit).
          await callTool(turn.mcpUrl, 'propor_ajuste', { agente: 'nina', esforco: 'high', limite: 500_000, motivo: L('Tarefas mais difíceis.', 'Harder tasks.') })
          reply = L('Subi o esforço da Nina; o limite novo espera você confirmar.', "I raised Nina's effort; the new limit waits for you to confirm.")
        } else if (/resumo di[aá]rio/i.test(last)) {
          await callTool(turn.mcpUrl, 'propor_rotina', { agente: 'nina', nome: L('Resumo diário', 'Daily summary'), pedido: L('Resuma o dia.', 'Sum up the day.'), dias: [1, 2, 3, 4, 5], hora: '18:00' })
          reply = L('Criei a rotina.', 'I made the routine.')
        } else if (/importa os bots/i.test(last)) {
          // Two new agents, each with a routine: a second propor_agente is refused and says to use a team,
          // and the team with both takes the first one's place. What it was told is kept in the reply.
          const agent = (nome: string): Record<string, unknown> => ({ nome, funcao: 'Bot', cor: 'rose', instrucoes: L(`Você é o ${nome}.\nFaz o que o bot antigo fazia.\nResponde curto.`, `You are ${nome}.\nDo what the old bot did.\nAnswer briefly.`), esforco: 'low', web: false })
          const told: string[] = []
          told.push(textOf(await callTool(turn.mcpUrl, 'propor_agente', agent('Sustinho'))))
          told.push(textOf(await callTool(turn.mcpUrl, 'propor_rotina', { agente: 'Sustinho', nome: 'Preparo do susto', pedido: 'Prepare o susto do dia.', dias: [0, 1, 2, 3, 4, 5, 6], hora: '08:00' })))
          told.push(textOf(await callTool(turn.mcpUrl, 'propor_agente', agent('Faro'))))
          told.push(textOf(await callTool(turn.mcpUrl, 'propor_time', { agentes: [agent('Sustinho'), agent('Faro')] })))
          told.push(textOf(await callTool(turn.mcpUrl, 'propor_rotina', { agente: 'Faro', nome: 'Faro da manhã', pedido: 'Fareje as novidades.', dias: [1, 2, 3, 4, 5], hora: '09:00' })))
          reply = told.join('\n---\n')
        } else if (/migra/i.test(last)) {
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
      } else if (turn.mcpUrl && /proponha o time (\p{L}+) e (\p{L}+)/iu.test(last)) {
        // Any agent proposing a team (not only the Tuca). "de novo em N s": proposes the same team again
        // that much later, in the same reply, to see what it's told once the first card was applied.
        const [, a, b] = /proponha o time (\p{L}+) e (\p{L}+)/iu.exec(last)!
        const team = { agentes: [a!, b!].map((nome) => ({ nome, funcao: 'Ops', cor: 'amber', instrucoes: `Você é ${nome}.\nCuida da entrega.\nResponde curto.`, esforco: 'low', web: false })) }
        const told = [textOf(await callTool(turn.mcpUrl, 'propor_time', team))]
        const again = /de novo em (\d+) ?s/i.exec(last)
        if (again) {
          await new Promise((r) => setTimeout(r, Number(again[1]) * 1000))
          told.push(textOf(await callTool(turn.mcpUrl, 'propor_time', team)))
        }
        reply = told.join('\n---\n')
      } else if (turn.mcpUrl && back) {
        // What came back from its team: a question left there is answered ("responda a dúvida com `x`", in
        // what the person wrote first) or taken to the person; an end is told in a line.
        const waiting = /\[([0-9a-f]{8})\][^\n]*(?:deixou uma pergunta|left a question)/.exec(back)
        const known = /respond[ae] (?:a d[úu]vida|the question) com `([^`]+)`/i.exec(turn.prompt)
        if (waiting && known) {
          await callTool(turn.mcpUrl, 'responder_pedido', { id: waiting[1]!, resposta: known[1]! })
          reply = '' // answered it itself: nothing for the person to read
        } else if (waiting) {
          await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
          reply = 'Ele precisa de uma decisão sua.'
        } else if (/: não terminou|did not finish/.test(back) && /se n[ãa]o sair, fa[çc]a voc[êe] \(([^)]*)\): ([^\n"]+)/i.test(turn.prompt)) {
          // "…; se não sair, faça você (contas): calcular a mediana": a part that didn't get done is not his to
          // take. He asks leave for it, as for anything no one on the team does.
          const [, kind, what] = /se n[ãa]o sair, fa[çc]a voc[êe] \(([^)]*)\): ([^\n"]+)/i.exec(turn.prompt)!
          // In whose place: the colleague the notice names. The card then asks this once, or wait for them.
          const who = /\] ([^,\n]+),[^\n]*?: (?:não terminou|did not finish)/.exec(back)?.[1]?.trim()
          const told = textOf(await callTool(turn.mcpUrl, 'fazer_eu_mesmo', { o_que: what!.trim(), tipo: kind!.trim(), web: false, ...(who ? { no_lugar_de: who } : {}) }))
          reply = /^(?:Pergunta enviada|Question sent)/.test(told) ? L(`${who ?? 'O colega'} não terminou: deu erro.`, `${who ?? 'The colleague'} did not finish: it hit an error.`) : told
        } else reply = /passou do prazo|past its deadline/.test(back) ? 'Passou do prazo e ainda não terminou.' : /: não terminou|did not finish/.test(back) ? 'Não deu certo: o pedido não terminou.' : 'Pronto: o time terminou o que pedi.'
      } else if (turn.mcpUrl && /(?:delegue|hand) (?:a|à|ao|pr[ao]|to) @?([\w-]+)(?: (?:em|in) #([\w-]+))?: ([^\n]+)/i.test(last)) {
        // "delegue a clara: responda o Fulano" (several lines: several requests), "delegue a clara em #vendas: …".
        const out: string[] = []
        for (const m of last.matchAll(/(?:delegue|hand) (?:a|à|ao|pr[ao]|to) @?([\w-]+)(?: (?:em|in) #([\w-]+))?: ([^\n]+)/gi)) out.push(textOf(await callTool(turn.mcpUrl, 'pedir', { para: m[1]!, pedido: m[3]!, ...(m[2] ? { canal: m[2] } : {}), ...(/prazo de (\d+) ?h/i.test(m[3]!) ? { prazo_horas: Number(/prazo de (\d+) ?h/i.exec(m[3]!)![1]) } : {}) })))
        // Asked: it ends with no text of its own (the person sees whom it asked under their message). What
        // didn't go out is said.
        reply = out.filter((t) => !/^(?:Pedido|Request) \[/.test(t)).join('\n')
        // "(e confirme)": a model that doesn't stop after asking. It saves a memory and then goes on with
        // the request it has just made, in the same reply.
        const made = /\[([0-9a-f]{8})\]/.exec(out[0] ?? '')?.[1]
        if (made && /\((?:e confirme|and confirm)\)/i.test(last)) {
          const who = /(?:delegue|hand) (?:a|à|ao|pr[ao]|to) @?([\w-]+)/i.exec(last)![1]!
          const saved = textOf(await callTool(turn.mcpUrl, 'lembrar', { texto: L('Avisos pros clientes vão pra quem escreve.', 'Notices to customers go to whoever writes.'), sobre: 'usuario' }))
          await callTool(turn.mcpUrl, 'pedir', { para: who, pedido: L('Só confirmando: siga o pedido anterior.', 'Just confirming: follow the request above.'), continuar: made })
          // ...and once more, and then asks the person "Ok" for something to end on: what each was told is its text.
          const again = textOf(await callTool(turn.mcpUrl, 'pedir', { para: who, pedido: L('Ignore a confirmação, foi redundante.', 'Ignore the confirmation, it was redundant.'), continuar: made }))
          const ok = textOf(await callTool(turn.mcpUrl, 'ask_user', { question: 'Ok' }))
          reply = [saved, again, ok].join('\n')
        }
      } else if (turn.mcpUrl && /^continue (?:com|with) @?([\w-]+): (.+)/i.test(last)) {
        // "continue com clara: e mande também pro Beltrano": the request that came back from her, in its thread.
        const [, who, what] = /^continue (?:com|with) @?([\w-]+): (.+)/i.exec(last)!
        const code = new RegExp(`\\[([0-9a-f]{8})\\] ${who![0]!.toUpperCase()}${who!.slice(1)},`).exec(turn.prompt)?.[1] ?? ''
        const out = textOf(await callTool(turn.mcpUrl, 'pedir', { para: who!, pedido: what!, continuar: code }))
        reply = /^(?:Pedido|Request) \[/.test(out) ? '' : out
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
      } else if (turn.mcpUrl && /^guarde em ([^:]+): ([^\n]+\.\w+) = ([\s\S]+)/i.test(last)) {
        // Documentos: "guarde em Empresa: ata.md = texto" saves a file; the two below list and read.
        const [, pasta, nome, texto] = /^guarde em ([^:]+): ([^\n]+\.\w+) = ([\s\S]+)/i.exec(last)!
        reply = textOf(await callTool(turn.mcpUrl, 'docs_guardar', { pasta: pasta!.trim(), nome: nome!.trim(), texto: texto!, resumo: texto!.split(/(?<=\.)\s/)[0]!.slice(0, 140) }))
      } else if (turn.mcpUrl && /^liste os documentos(?: de (.+))?/i.test(last)) {
        const pasta = /^liste os documentos(?: de (.+))?/i.exec(last)![1]?.trim()
        reply = textOf(await callTool(turn.mcpUrl, 'docs_listar', pasta ? { pasta } : {}))
      } else if (turn.mcpUrl && /^leia o documento (.+)/i.test(last)) {
        reply = textOf(await callTool(turn.mcpUrl, 'docs_ler', { documento: /^leia o documento (.+)/i.exec(last)![1]!.trim() }))
      } else if (turn.mcpUrl && /^rode no computador: (.+)/i.test(last)) {
        // A command on a computer lent to this server (core/node-link.ts), for trying the line end to end.
        const r = await callTool(turn.mcpUrl, await toolNamed(turn.mcpUrl, 'node_bash'), { command: /^rode no computador: (.+)/i.exec(last)![1]! })
        reply = textOf(r)
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
      } else if (turn.mcpUrl && /sem pressa com a skill `([\w-]+)`/i.test(last)) {
        // A run that is still working when the person steers it: a step, a pause long enough to write
        // in (TUCANO_FAKE_HOLD_MS), then a second call, which is where the steer is handed over. Only
        // the fake engine holds: it is how the steer pill can be shown at all (screens-steer-pill.mjs).
        const [, nome] = /sem pressa com a skill `([\w-]+)`/i.exec(last)!
        await callTool(turn.mcpUrl, 'ler_skill', { nome })
        await new Promise((ok) => setTimeout(ok, Number(process.env['TUCANO_FAKE_HOLD_MS'] ?? 6000)))
        await callTool(turn.mcpUrl, 'ler_skill', { nome })
        reply = L('Segui a orientação e terminei.', 'I followed the steer and finished.')
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
      } else if (/\b(?:was cut when the app closed|was cut by a failure|was cut before it finished|foi cortada quando|foi cortada por uma falha)/i.test(turn.prompt)) {
        // A reply the app cut, continued: the steps it already took are in its task, so it says how
        // many there were and goes on instead of redoing them (src/core/runs.ts, continue()).
        const told = /(?:The steps you took|Os passos que você fez):\n([\s\S]*?)\n\n/.exec(turn.prompt)?.[1] ?? ''
        const done = told
          .split('\n')
          .filter((l) => l.trim().startsWith('-'))
          .map((l) => l.trim().slice(2).split(':')[0]!.trim())
        reply = L(
          `Continuei dali: ${done.join(', ')} já estavam prontos, e não refiz nenhum.`,
          `I went on from there: ${done.join(', ')} were already done, and I redid none of them.`
        )
      } else if (turn.mcpUrl && /lembre e procure:/i.test(last)) {
        // A memory written and then searched, then a hold: two real steps behind a reply, and a pause
        // long enough for the app to be killed between them (scripts/e2e-kill-restart.mjs). Neither
        // call needs a computer, so this runs on any host the app runs on.
        const texto = /lembre e procure:\s*(.+)/is.exec(last)![1]!.trim()
        await callTool(turn.mcpUrl, 'lembrar', { texto, sobre: 'usuario' })
        await callTool(turn.mcpUrl, 'buscar_memorias', { busca: texto })
        await new Promise((ok) => setTimeout(ok, Number(process.env['TUCANO_FAKE_HOLD_MS'] ?? 6000)))
        reply = L('Guardei e procurei de volta.', 'I saved it and searched it back.')
      } else if (turn.mcpUrl && /lembr[ae] que (.+)/i.test(last)) {
        const texto = /lembr[ae] que (.+)/i.exec(last)![1]!.trim()
        await callTool(turn.mcpUrl, 'lembrar', { texto, sobre: 'usuario' })
        reply = 'Anotado.'
      } else if (/A pessoa preferiu não responder|The person chose not to answer/.test(turn.prompt)) {
        // Its question was cancelled (Cancelar on the card): it goes on without the answer, and says what it assumed.
        reply = L('Segui sem a resposta: assumi que é pra sexta.', 'Went on without the answer: I assumed Friday.')
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
      } else if (turn.mcpUrl && /pr[oó]ximos passos/i.test(last)) {
        // "os próximos passos": a to-do card, one of its steps plainly optional.
        const r = await callTool(turn.mcpUrl, 'next_steps', {
          question: 'O que vem agora?',
          steps: [
            { label: 'Rodar a suíte inteira', description: 'o que já está escrito' },
            { label: 'Traduzir os rótulos novos' },
            { label: 'Escrever o teste do card' },
            { label: 'Publicar as capturas', description: 'só quando o resto estiver verde' }
          ]
        })
        reply = textOf(r).includes('card') ? 'Deixei os próximos passos no card.' : textOf(r)
      } else if (turn.mcpUrl && /pergunte (?:a|à|pra|para) (\p{L}+)/iu.test(last)) {
        // "pergunte a Bia": a question to someone in particular (a Tucano with people).
        const r = await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?', para: /pergunte (?:a|à|pra|para) (\p{L}+)/iu.exec(last)![1]! })
        reply = textOf(r).includes('autorizar') || textOf(r).includes('allow') ? 'Vou perguntar se deixarem.' : 'Mandei a pergunta.'
      } else if (/pergunt/i.test(last) && turn.mcpUrl) {
        await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
        reply = 'Te mandei uma pergunta.'
      } else if (/carries on from your last reply in this conversation|continuação da sua última resposta nesta conversa/i.test(turn.prompt)) {
        // A reply going on from where it stopped (src/core/runs.ts, `followIn`): it says so instead of
        // repeating, paragraph for paragraph, the answer it already gave.
        reply = L('Segui dali: o resto do que faltava está feito.', 'I went on from there: the rest of what was missing is done.')
      } else {
        reply = `Resposta de teste (${id} · ${turn.model}). Recebi ${turn.prompt.length} caracteres de contexto.`
      }

      const inputTokens = Math.ceil((turn.system.length + turn.prompt.length) / 4)
      yield { type: 'progress', tokens: inputTokens + spend }
      // "demore 8 s": a reply that takes its time, to see one at work.
      const slow = /^\s*(?:delegue|hand) /i.test(last) ? null : /demore (\d+) ?s/i.exec(last) // what it hands down is the other's to take its time on
      if (slow) await new Promise((r) => setTimeout(r, Number(slow[1]) * 1000))
      if (id === 'claude') yield { type: 'quota', quota: { fiveHour: { utilization: 0.34, resetsAt: Date.now() + 2 * 3_600_000 }, sevenDay: { utilization: 0.21, resetsAt: Date.now() + 4 * 86_400_000 }, at: Date.now() } }
      // With TUCANO_FAKE_THINKING=1, the model thinks out loud first, slowly, so the window has
      // something to show as it arrives: the same shape Pi's thinking_delta has.
      if (process.env['TUCANO_FAKE_THINKING'] === '1') {
        const thoughts = [
          'Reading the request: it is about ',
          'a piece of code and a test that fails. ',
          'Before answering, worth seeing where the request comes from ',
          'and what was already said in this conversation. ',
          'The short path is reading the file it names, ',
          'src/renderer/src/components/Conversation.tsx:11799 ',
          'checking the version in the repository ',
          'and only then saying what to do. ',
          'If the test fails the same on a clean main, it is not the build. ',
          'Better to say that with the number in hand. ',
          'This machine may not have the branch the test was written on, ',
          'so a failure here says nothing about the build yet. ',
          'First the file, then whether the same test fails on a clean main. ',
          'If it does, the machine and the build are both fine. ',
          'If it passes there, something in this checkout changed under it. ',
          'Also worth checking the Node version the runner used, ',
          'since the suite pins nothing and this machine may run another one. ',
          'That is the whole plan: two runs, one comparison, and the number. ',
          'One more thing before the run: the suite reads its fixtures from the repository, ',
          'so a checkout that is behind would fail for a reason that has nothing to do with the code. ',
          'Worth printing the commit first as well. ',
          'Then the two runs against that same commit, one here and one on a clean main. ',
          'If the numbers agree the machine is out of it entirely. ',
          'If they differ, the difference is the answer and it needs to be said the same way. ',
          'No guessing before the runs: a wrong cause costs more than the minute they take.'
        ]
        for (const piece of thoughts) {
          if (turn.signal.aborted) return
          await new Promise((r) => setTimeout(r, 260))
          yield { type: 'thinking', delta: piece }
        }
      }
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

// The cataloguer (core/docs-brain.ts): a summary from the file's first line, the dates after "vence"/"prazo"/"renova", and the first folder named in the file.
function fakeCatalog(prompt: string): { resumo: string; datas: { data: string; o_que: string }[]; pasta: number | null; nome: null } {
  const file = /<<<ARQUIVO\n([\s\S]*?)\nARQUIVO>>>/.exec(prompt)?.[1] ?? ''
  const name = /^(?:Nome do arquivo|File name): (.*)$/m.exec(prompt)?.[1] ?? ''
  const datas: { data: string; o_que: string }[] = []
  for (const m of file.matchAll(/(?:venc\w*|prazo|renova\w*)\D{0,20}?(?:(\d{2})\/(\d{2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2}))/gi)) datas.push({ data: m[4] ? `${m[4]}-${m[5]}-${m[6]}` : `${m[3]}-${m[2]}-${m[1]}`, o_que: 'vencimento' })
  let pasta: number | null = null
  const list = /(?:Pastas possíveis|Possible folders):\n([\s\S]*)$/.exec(prompt)?.[1]
  if (list) {
    const hay = `${name}\n${file}`.toLowerCase()
    for (const line of list.split('\n')) {
      const row = /^(\d+)\. (.*?) — /.exec(line)
      const last = row?.[2]?.split('/').pop()?.toLowerCase()
      if (row && last && hay.includes(last)) {
        pasta = Number(row[1])
        break
      }
    }
  }
  // The first line that says something, without what Markdown or a table puts around it.
  const line = file.split('\n').map((l) => l.replace(/^#+\s*/, '').replace(/[|*_`>]+/g, ' ').replace(/\s+/g, ' ').trim()).find((l) => /\p{L}/u.test(l)) ?? ''
  return { resumo: line.slice(0, 120), datas, pasta, nome: null }
}

// A question about the documents: an answer when there is at least one excerpt.
function fakeAnswer(prompt: string): { achou: boolean; resposta?: string } {
  // The sentence of the first stretch that has a number in it (a date, a value), else its first one: enough to see an answer with its source.
  const first = /^\[1\] .*\n<<<TRECHO\n([\s\S]*?)\nTRECHO>>>/m.exec(prompt)?.[1]
  if (first === undefined) return { achou: false }
  const said = first.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).map((x) => x.trim()).filter(Boolean)
  return { achou: true, resposta: `${(said.find((x) => /\d/.test(x)) ?? said[0] ?? '').slice(0, 200)} [1]` }
}

// The wiki's curator, for trying it without an engine: a page the stretch names gets a line
// under History; a stretch with numbers or a decision becomes a page of its own.
function fakeCuration(prompt: string): { guardar: boolean; motivo: string; titulo_fonte: string; mudancas: Record<string, string>[] } {
  const stretch = prompt.split(/\n## [^\n]*(?:Trecho|Stretch)[^\n]*\n/)[1]?.split('\n\nResponda')[0]?.split('\n\nReply')[0] ?? ''
  const titles = [...prompt.matchAll(/^- \[\[([^\]]+)\]\]/gm)].map((m) => m[1]!)
  const named = titles.find((t) => t.toLowerCase().split(/\s+/).filter((w) => w.length >= 5).some((w) => stretch.toLowerCase().includes(w)))
  const plain = stretch.replace(/\*\*[^*]+\*\* \([^)]*\): /g, '').replace(/\s+/g, ' ').trim()
  const line = plain.length > 160 ? `${plain.slice(0, 157)}…` : plain
  const day = new Date().toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })
  const mudancas: Record<string, string>[] = []
  if (named) mudancas.push({ op: 'append', pagina: named, secao: L('Histórico', 'History'), texto: `- **${day}:** ${line}` })
  if (/\d|decid|fech|guarda/i.test(plain) && !named) mudancas.push({ op: 'create', pagina: plain.split(/[.!?:]/)[0]!.split(' ').slice(0, 5).join(' '), tipo: L('Assunto', 'Topic'), texto: `${line}\n\n## ${L('Detalhes', 'Details')}\n- ${line}` })
  return { guardar: mudancas.length > 0, motivo: L('Um fato que vale lembrar.', 'A fact worth remembering.'), titulo_fonte: plain.split(/[.!?]/)[0]!.slice(0, 60) || L('Trecho de conversa', 'Conversation excerpt'), mudancas }
}

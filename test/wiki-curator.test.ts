import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent, Message, Settings } from '../src/shared/types'
import { applyOp, Wiki } from '../src/core/wiki'
import { curatorSystem, parseCuration, WikiCurator } from '../src/core/wiki-curator'

const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  return w
}
const by = { by: 'me', byName: 'Ana' }

describe('a change on a page', () => {
  it('adds under a section, makes the section when missing, swaps an exact passage', () => {
    const body = '# Marcos\n\nCliente.\n\n## Histórico\n- 28/10: pediu orçamento.\n\n## Contato\n- (41) 9999'
    expect(applyOp(body, { op: 'append', page: 'M', section: 'Histórico', text: '- 03/11: recebeu.' })).toContain('- 28/10: pediu orçamento.\n- 03/11: recebeu.\n\n## Contato')
    expect(applyOp(body, { op: 'append', page: 'M', section: 'Decisões', text: '- Piso vinílico.' })).toMatch(/## Decisões\n- Piso vinílico\.\n$/)
    expect(applyOp(body, { op: 'replace', page: 'M', old: '(41) 9999', new: '(41) 8888' })).toContain('(41) 8888')
    expect(() => applyOp(body, { op: 'replace', page: 'M', old: 'não existe', new: 'x' })).toThrow()
  })
})

describe('change packages', () => {
  it('applies, refuses on a conflict, and undoes', () => {
    const w = fresh()
    w.save({ title: 'Marcos Lima', body: 'Cliente.\n\n## Histórico\n- 28/10: pediu orçamento.', ...by })
    const c = w.addChange({ ops: [{ op: 'append', page: 'Marcos Lima', section: 'Histórico', text: '- 03/11: recebeu o orçamento.' }, { op: 'create', page: 'Reforma', kind: 'Projeto', text: 'Do [[Marcos Lima]].' }], by: 'auto' })
    expect(c.state).toBe('pending')
    expect(w.applyChange(c.id, 'Curador').state).toBe('applied')
    expect(w.page('Marcos Lima')!.body).toContain('03/11: recebeu')
    expect(w.page('Reforma')!.kind).toBe('Projeto')
    w.undoChange(c.id, 'Ana')
    expect(w.page('Reforma')).toBeUndefined()
    expect(w.page('Marcos Lima')!.body).not.toContain('03/11')
    expect(w.change(c.id)!.state).toBe('undone')

    // a page changed after the package was made: nothing is written
    const c2 = w.addChange({ ops: [{ op: 'append', page: 'Marcos Lima', text: 'x' }], by: 'auto' })
    const p = w.page('Marcos Lima')!
    w.save({ title: 'Marcos Lima', body: p.body + '\nEditada por mim.', expectedHash: p.hash, ...by })
    expect(w.applyChange(c2.id, 'Ana').state).toBe('conflict')
    expect(w.page('Marcos Lima')!.body).not.toMatch(/\nx\n/)
    w.refuseChange(c2.id)
    expect(w.change(c2.id)!.state).toBe('refused')
  })

  it('keeps a source as it came, in the fontes folder', () => {
    const w = fresh()
    const s = w.addSource({ title: 'E-mail do Marcos', text: 'Quero começar em janeiro.', kind: 'message', by: 'auto' })
    expect(s.file).toMatch(/^fontes\/\d{4}-\d\d-\d\d \d{4} E-mail do Marcos$/)
    expect(w.source(s.id)!.text).toContain('Quero começar em janeiro.')
    expect(w.sources()[0]!.title).toBe('E-mail do Marcos')
  })
})

describe('the curator', () => {
  const agents = [{ id: 'lia', name: 'Lia' } as Agent]
  const off = new Set<string>()
  const setup = (reply: (prompt: string) => string, settings: Partial<Settings> = {}) => {
    const w = fresh()
    const messages: Message[] = []
    const emitted: Message[] = []
    const calls: string[] = []
    const curator = new WikiCurator({
      wiki: w,
      db: {
        conversation: (id) => ({ id, kind: 'dm', name: 'lia', ...(off.has(id) ? { wikiCapture: false } : {}) }),
        messagesAfter: (_c, at) => messages.filter((m) => m.at > at),
        message: (id) => messages.find((m) => m.id === id),
        saveMessage: (m) => messages.splice(messages.findIndex((x) => x.id === m.id), 1, m),
        agents: () => agents
      },
      settings: () => ({ workspaceName: 'Ana', ...settings }) as Settings,
      llm: async (_s, prompt) => (calls.push(prompt), reply(prompt)),
      emitMessage: (m) => emitted.push(m)
    })
    const say = (id: string, who: 'me' | 'lia', text: string, at: number): void => {
      messages.push({ id, conversationId: 'c', author: who === 'me' ? { kind: 'me' } : { kind: 'agent', id: 'lia' }, text, at, ...(who === 'lia' ? { run: { status: 'done', steps: [] } } : {}) } as Message)
    }
    return { w, curator, say, calls, emitted, messages }
  }
  const decision = JSON.stringify({
    guardar: true,
    motivo: 'Uma decisão sobre a reforma.',
    titulo_fonte: 'Orçamento aceito',
    mudancas: [
      { op: 'create', pagina: 'Reforma do apto 302', tipo: 'Projeto', texto: 'Reforma do [[Marcos Lima]].\n\n## Decisões\n- Fechou em R$ 12.960.' },
      { op: 'append', pagina: 'Marcos Lima', secao: 'Histórico', texto: '- 03/11: aceitou o orçamento.' }
    ]
  })

  it('keeps a decision: the new page goes in, the edit waits for you, the reply says so', async () => {
    const { w, curator, say, emitted } = setup(() => '```json\n' + decision + '\n```')
    w.save({ title: 'Marcos Lima', kind: 'Pessoa', body: 'Cliente.\n\n## Histórico\n- 28/10: pediu orçamento.', ...by })
    say('m1', 'me', 'O Marcos aceitou o orçamento de R$ 12.960 da reforma, fechado em 3 vezes. Começa em janeiro.', 1)
    say('m2', 'lia', 'Ótimo! Anotei: reforma do apto 302 fechada em R$ 12.960, em 3 vezes, começo em janeiro.', 2)
    await curator.read('c')
    expect(w.page('Reforma do apto 302')!.body).toContain('Fechou em R$ 12.960.')
    expect(w.page('Reforma do apto 302')!.body).toMatch(/Fontes: \[\[fontes\/.+\|Orçamento aceito\]\]/)
    expect(w.page('Marcos Lima')!.body).not.toContain('aceitou') // waits
    const [pending] = w.changes('pending')
    expect(pending!.ops[0]!.text).toMatch(/aceitou o orçamento\. \(\[\[fontes\/.+\|fonte\]\]\)$/)
    expect(emitted.at(-1)!.run!.wikiChanges).toHaveLength(2)
    expect(w.mark('c')).toBe(2)
  })

  it('with edits on auto, the edit goes in too', async () => {
    const { w, curator, say } = setup(() => decision, { wikiEdits: 'auto' })
    w.save({ title: 'Marcos Lima', body: 'Cliente.\n\n## Histórico\n- 28/10.', ...by })
    say('m1', 'me', 'O Marcos aceitou o orçamento de R$ 12.960 da reforma, fechado em 3 vezes, e quer começar em janeiro.', 1)
    say('m2', 'lia', 'Ótimo, fica registrado: R$ 12.960 em 3 vezes, começo em janeiro.', 2)
    await curator.read('c')
    expect(w.page('Marcos Lima')!.body).toContain('aceitou o orçamento')
    expect(w.changes('pending')).toHaveLength(0)
  })

  it('reads nothing twice, skips small talk without asking the model, and keeps nothing when it says so', async () => {
    const { w, curator, say, calls } = setup(() => JSON.stringify({ guardar: false, mudancas: [] }))
    say('m1', 'me', 'oi', 1)
    say('m2', 'lia', 'Oi, Ana!', 2)
    await curator.read('c')
    expect(calls).toHaveLength(0)
    say('m3', 'me', 'Que horas são em Tóquio agora? Estou curiosa pra saber a diferença de fuso de lá pra cá.', 3)
    say('m4', 'lia', 'Em Tóquio são 22h agora: 12 horas a mais que Curitiba, já que lá não tem horário de verão.', 4)
    await curator.read('c')
    await curator.read('c')
    expect(calls).toHaveLength(1)
    expect(w.sources()).toHaveLength(0)
  })

  it('keeps a message on purpose, with the question it answered', async () => {
    const { w, curator, say, calls } = setup(() => JSON.stringify({ guardar: false, titulo_fonte: 'Roteiro', mudancas: [{ op: 'create', pagina: 'Viagem a Morretes', tipo: 'Projeto', texto: 'Trem às 8h15.' }] }))
    say('m1', 'me', 'Planeja o feriado', 1)
    say('m2', 'lia', 'Morretes de trem, saindo às 8h15.', 2)
    expect(await curator.keepMessage('m2')).toHaveLength(1)
    expect(calls[0]).toContain('pediu pra guardar')
    expect(calls[0]).toContain('Planeja o feriado')
    expect(w.page('Viagem a Morretes')).toBeDefined()
  })

  it("doesn't read again what was kept on purpose", async () => {
    const { curator, say, calls } = setup(() => JSON.stringify({ guardar: true, titulo_fonte: 'Fechamento', mudancas: [{ op: 'create', pagina: 'Reforma', tipo: 'Projeto', texto: 'Fechada.' }] }))
    say('m1', 'me', 'O Marcos fechou a reforma! Começa dia 12 de janeiro, em 3 vezes de R$ 4.320.', 1)
    say('m2', 'lia', 'Que ótimo! Reforma fechada: começa em 12/01, 3 parcelas de R$ 4.320.', 2)
    await curator.keepMessage('m2')
    await curator.read('c') // the conversation settles: those two are already kept
    expect(calls).toHaveLength(1)
    say('m3', 'me', 'Na verdade começa dia 15 de janeiro, o Marcos pediu pra adiar uns dias por causa da mudança.', 3)
    say('m4', 'lia', 'Anotado: o início da reforma passa pra 15/01, a pedido do Marcos. As parcelas continuam as mesmas, 3 de R$ 4.320.', 4)
    await curator.read('c')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('15 de janeiro')
    expect(calls[1]).not.toContain('Começa dia 12')
  })

  it("drops a change the model itself says won't matter in three months", () => {
    const out = parseCuration(JSON.stringify({ guardar: true, mudancas: [
      { op: 'append', pagina: 'Reforma do apto 302', secao: 'Situação', texto: 'Contrato assinado em 05/11.', lasting: true },
      { op: 'append', pagina: 'Marcos Lima', secao: 'Histórico', texto: '- 03/11: a Lia mandou o e-mail de confirmação.', lasting: false },
      { op: 'append', pagina: 'Marcos Lima', secao: 'Contato', texto: '- Prefere WhatsApp.' }
    ] }))!
    expect(out.ops.map((o) => o.text)).toEqual(['Contrato assinado em 05/11.', '- Prefere WhatsApp.'])
  })

  it('shows the model the pages the stretch names, even after a long reply', async () => {
    const { w, curator, say, calls } = setup(() => JSON.stringify({ guardar: false, mudancas: [] }))
    w.save({ title: 'Rogério', kind: 'Pessoa', body: 'Engenheiro da construtora. Telefone (41) 3333-2222.', ...by })
    say('m1', 'me', 'Rascunha um e-mail pedindo a visita técnica.', 1)
    say('m2', 'lia', `Rascunho: ${'Bom dia, preciso marcar a visita técnica no apartamento. '.repeat(20)}`, 2)
    say('m3', 'me', 'Anota aí: o Rogério mudou de telefone, agora é (41) 98888-7777.', 3)
    say('m4', 'lia', 'Anotado.', 4)
    await curator.read('c')
    expect(calls[0]).toContain('### [[Rogério]]')
  })

  it('a swap aimed at the wrong page goes to the one that has the passage, or becomes an addition', async () => {
    const reply = JSON.stringify({ guardar: true, titulo_fonte: 'Telefone novo', mudancas: [
      { op: 'replace', pagina: 'Rogério', old: '(41) 3333-2222', new: '(41) 98888-7777' },
      { op: 'replace', pagina: 'Rogério', secao: 'Contato', old: 'texto que não existe', new: 'Responde de manhã.' }
    ] })
    const { w, curator, say } = setup(() => reply, { wikiEdits: 'auto' })
    w.save({ title: 'Rogério', kind: 'Pessoa', body: 'Engenheiro da [[Construtora Alpha]].', ...by })
    w.save({ title: 'Construtora Alpha', kind: 'Assunto', body: 'Contato: [[Rogério]], (41) 3333-2222.', ...by })
    say('m1', 'me', 'O Rogério mudou de telefone, agora é (41) 98888-7777, e ele prefere ser chamado de manhã cedo.', 1)
    say('m2', 'lia', 'Anotado o telefone novo do Rogério, e que ele responde melhor de manhã.', 2)
    await curator.read('c')
    expect(w.page('Construtora Alpha')!.body).toContain('(41) 98888-7777')
    expect(w.page('Rogério')!.body).toContain('Responde de manhã.')
    expect(w.changes('conflict')).toHaveLength(0)
  })

  it('tells the model the wiki is knowledge, not a record of tasks', () => {
    expect(curatorSystem()).toMatch(/registro da tarefa|record of the task/)
    expect(curatorSystem()).toMatch(/"lasting"/)
  })

  it('reads the model leniently', () => {
    expect(parseCuration('nada')).toBeNull()
    expect(parseCuration('{"guardar": true, "mudancas": [{"op": "append", "pagina": "[[X]]", "texto": "y"}, {"op": "replace", "pagina": "X"}, {"op": "voar", "pagina": "X"}]}')).toMatchObject({ worth: true, ops: [{ op: 'append', page: 'X', text: 'y' }] })
  })

  it('leaves out a conversation kept out of the wiki, but keeps a message kept on purpose', async () => {
    const { w, curator, say, calls } = setup(() => decision)
    off.add('c')
    say('m1', 'me', 'O Marcos aceitou o orçamento de R$ 12.960 da reforma, fechado em 3 vezes, e quer começar em janeiro.', 1)
    say('m2', 'lia', 'Ótimo, fica registrado: R$ 12.960 em 3 vezes, começo em janeiro.', 2)
    await curator.read('c')
    expect(calls).toHaveLength(0)
    expect(await curator.keepMessage('m2')).not.toHaveLength(0)
    expect(w.page('Reforma do apto 302')).toBeDefined()
    off.clear()
  })

  it('redoes a conflict on the newer page; when the passage is gone, writes it again from the source', async () => {
    const { w, curator } = setup(() => JSON.stringify({ guardar: true, mudancas: [{ op: 'append', pagina: 'Marcos Lima', secao: 'Histórico', texto: '- 03/11: refeito.' }] }))
    w.save({ title: 'Marcos Lima', body: 'Cliente.\n\n## Histórico\n- 28/10.', ...by })
    const src = w.addSource({ title: 'Conversa', text: 'O Marcos aceitou.', kind: 'conversation', by: 'auto' })
    const append = w.addChange({ ops: [{ op: 'append', page: 'Marcos Lima', section: 'Histórico', text: '- 03/11: aceitou.' }], sourceId: src.id, by: 'auto' })
    const swap = w.addChange({ ops: [{ op: 'replace', page: 'Marcos Lima', old: 'Cliente.', new: 'Cliente desde março.' }], sourceId: src.id, by: 'auto' })
    const p = w.page('Marcos Lima')!
    w.save({ title: 'Marcos Lima', body: p.body.replace('Cliente.', 'Cliente antigo.'), expectedHash: p.hash, ...by })
    expect(w.applyChange(append.id, 'Ana').state).toBe('conflict')
    expect(w.applyChange(swap.id, 'Ana').state).toBe('conflict')
    // the add still fits: made again on the page as it is now
    const [again] = await curator.redo(append.id)
    expect(again!.state).toBe('pending')
    expect(w.change(append.id)!.state).toBe('refused')
    expect(w.applyChange(again!.id, 'Ana').state).toBe('applied')
    expect(w.page('Marcos Lima')!.body).toContain('Cliente antigo.')
    expect(w.page('Marcos Lima')!.body).toContain('03/11: aceitou.')
    // the swapped passage is gone: the curator writes it again from the source
    const redone = await curator.redo(swap.id)
    expect(redone).toHaveLength(1)
    expect(redone[0]!.ops[0]!.text).toContain('refeito.')
  })
})

describe('the wiki in another folder', () => {
  it('moves to another folder with an index of its own, and comes back', () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
    const w = new Wiki({ dir: join(root, 'a'), indexPath: join(root, 'a.db') })
    w.init(false)
    w.save({ title: 'Na pasta A', body: 'a', ...by })
    w.relocate(join(root, 'b'), join(root, 'b.db'))
    expect(w.list()).toEqual([])
    w.save({ title: 'Na pasta B', body: 'b', ...by })
    w.relocate(join(root, 'a'), join(root, 'a.db'))
    expect(w.list().map((p) => p.title)).toEqual(['Na pasta A'])
    w.close()
  })
})

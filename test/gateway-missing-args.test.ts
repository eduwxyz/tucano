// A call without what its tool requires says which, what was sent, and the tool's parameters, so the
// model can call again with the right names. A harness that keeps tools behind a search (Grok's
// use_tool) lets the model call one by a name it read without its schema, and it guesses.
import { describe, expect, it } from 'vitest'
import { missingArgs, type ToolDef } from '../src/core/gateway'
import { setLang } from '../src/shared/lang'

setLang('pt')
const tool: ToolDef = { name: 'docs_buscar', description: 'Busca.', inputSchema: { type: 'object', properties: { busca: { type: 'string', description: 'O que buscar.' }, pasta: { type: 'string' } }, required: ['busca'] } }

describe('a call missing what its tool requires', () => {
  it('says what is missing, what was sent, and the parameters', () => {
    const r = missingArgs(tool, { query: 'proposta' })!
    expect(r.isError).toBe(true)
    const text = (r.content[0] as { text: string }).text
    expect(text).toContain('Faltou "busca" em docs_buscar. Nada foi feito.')
    expect(text).toContain('Você mandou: query.')
    expect(text).toContain('- busca (string, obrigatório): O que buscar.')
    expect(text).toContain('- pasta (string)')
  })

  it('lets a complete call through, and a tool with nothing required', () => {
    expect(missingArgs(tool, { busca: 'x' })).toBeUndefined()
    expect(missingArgs({ ...tool, inputSchema: { type: 'object' } }, {})).toBeUndefined()
  })

  it('says so when nothing was sent', () => {
    expect((missingArgs(tool, {})!.content[0] as { text: string }).text).toContain('Você não mandou nenhum parâmetro.')
  })
})

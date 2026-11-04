import { describe, expect, it } from 'vitest'
import { remarkMentions, splitMentions } from '../src/shared/mention-text'

describe('finding mentions in text', () => {
  it('splits @handles out, keeping the text around them', () => {
    expect(splitMentions('oi @ana, vê com @bruno-dev.')).toEqual([{ text: 'oi ' }, { handle: 'ana', text: '@ana' }, { text: ', vê com ' }, { handle: 'bruno-dev', text: '@bruno-dev' }, { text: '.' }])
  })
  it('leaves out emails, double @ and handles in code', () => {
    const handles = (t: string): string[] => splitMentions(t).flatMap((p) => ('handle' in p ? [p.handle] : []))
    expect(handles('mande pra x@y.com e @@ana')).toEqual([])
    expect(handles('rode `@ana faça` e\n```\n@bruno\n```\ndepois @caio')).toEqual(['caio'])
  })
  it('gives back the whole text', () => {
    const text = 'a `@b` @c\n```\n@d\n```\n@e!'
    expect(splitMentions(text).map((p) => p.text).join('')).toBe(text)
  })
})

describe('the remark plugin', () => {
  it('turns @handles in text into spans the renderer reads, and leaves code and links alone', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'oi @ana e ' },
            { type: 'inlineCode', value: '@bruno' },
            { type: 'link', url: 'x', children: [{ type: 'text', value: '@caio' }] },
            { type: 'strong', children: [{ type: 'text', value: '@duda' }] }
          ]
        }
      ]
    }
    remarkMentions()(tree)
    const json = JSON.stringify(tree)
    expect(json.match(/"dataMention":"[^"]+"/g)).toEqual(['"dataMention":"ana"', '"dataMention":"duda"'])
    expect(json).toContain('"value":"@bruno"')
    expect(json).toContain('"value":"@caio"')
  })
})

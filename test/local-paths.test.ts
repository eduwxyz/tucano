import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { isLimited, localUrl, resolveLocal, verifyLocalUrl, type LocalReach } from '../src/core/local-paths'
import { codePath, LOCAL_LINK, remarkLocalPaths, splitPaths } from '../src/shared/path-text'

const paths = (text: string, folder?: string): string[] => splitPaths(text, folder).parts.flatMap((p) => ('path' in p ? [p.path] : []))

describe('finding paths in text', () => {
  it('finds absolute and home paths, leaving out the punctuation after them', () => {
    expect(paths('Salvei em /tmp/x/a.png, e também ~/Desktop/b.txt.')).toEqual(['/tmp/x/a.png', '~/Desktop/b.txt'])
  })
  it('reads accents, in either form', () => {
    expect(paths('Veja /tmp/relatório/área.png.')).toEqual(['/tmp/relatório/área.png'])
    expect(paths('Veja /tmp/relato\u0301rio/a.png.')).toEqual(['/tmp/relato\u0301rio/a.png'])
    expect(paths('Em /tmp/relatório/ ficou capa-açaí.png.')).toEqual(['/tmp/relatório/', '/tmp/relatório/capa-açaí.png'])
  })

  it('leaves out links, slashes in words, routes of one level and the root', () => {
    expect(paths('https://site.com/a/b e/ou and/or /api / 16/10/2026 x:/y/z')).toEqual([])
  })
  it('keeps the text around them', () => {
    const { parts } = splitPaths('veja /tmp/a/b.png agora')
    expect(parts).toEqual([{ text: 'veja ' }, { path: '/tmp/a/b.png', text: '/tmp/a/b.png' }, { text: ' agora' }])
  })
  it('reads names after a folder, as in the real message', () => {
    const r = splitPaths('/private/tmp/s/scratchpad/: home-390.png, stmt-1280.png e stmt-scrolled-390.png.')
    expect(r.parts.flatMap((p) => ('path' in p ? [p.path] : []))).toEqual(['/private/tmp/s/scratchpad/', '/private/tmp/s/scratchpad/home-390.png', '/private/tmp/s/scratchpad/stmt-1280.png', '/private/tmp/s/scratchpad/stmt-scrolled-390.png'])
    expect(r.folder).toBe('/private/tmp/s/scratchpad/')
  })
  it('a name with no folder before it stays text', () => {
    expect(paths('olhe home-390.png')).toEqual([])
    expect(paths('olhe home-390.png', '/tmp/s/')).toEqual(['/tmp/s/home-390.png'])
  })
  it('takes inline code whole, spaces included', () => {
    expect(codePath('~/Library/Application Support/Tucano')).toBe('~/Library/Application Support/Tucano')
    expect(codePath('npm run dev')).toBeUndefined()
    expect(codePath('a.png')).toBeUndefined()
    expect(codePath('a.png', '/tmp/s/')).toBe('/tmp/s/a.png')
  })
  it('turns text and inline code into links, and leaves code blocks and links alone', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'em /tmp/s/: ' }, { type: 'inlineCode', value: 'a.png' }] },
        { type: 'code', value: '/tmp/s/nao.png' },
        { type: 'paragraph', children: [{ type: 'link', url: 'https://x.com', children: [{ type: 'text', value: '/tmp/s/nao.png' }] }] }
      ]
    }
    remarkLocalPaths()(tree)
    const urls = JSON.stringify(tree).match(/tucano-local:[^"]+/g)!.map((u) => decodeURIComponent(u.slice(LOCAL_LINK.length)))
    expect(urls).toEqual(['/tmp/s/', '/tmp/s/a.png'])
  })
})

describe.runIf(process.platform !== 'win32')('what a path can do', () => {
  let root = ''
  let reach: LocalReach
  const file = (rel: string): string => {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, 'x')
    return p
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ad-local-')))
    mkdirSync(join(root, 'dados/computers/ada/work'), { recursive: true })
    reach = { agentId: 'ada', own: join(root, 'dados/computers/ada/work'), dataRoot: join(root, 'dados'), tmp: [join(root, 'tmp')], limited: false }
  })

  it('says what each thing is, and a missing one is nothing', () => {
    expect(resolveLocal(file('p/a.PNG'), reach)?.kind).toBe('image')
    expect(resolveLocal(file('p/a.mp4'), reach)?.kind).toBe('video')
    expect(resolveLocal(file('p/a.pdf'), reach)?.kind).toBe('pdf')
    expect(resolveLocal(file('p/a.sh'), reach)?.kind).toBe('file')
    expect(resolveLocal(join(root, 'p'), reach)?.kind).toBe('folder')
    expect(resolveLocal(join(root, 'p/sumiu.png'), reach)).toBeNull()
    expect(resolveLocal('relativo/a.png', reach)).toBeNull()
  })

  it('a folder with an extension, like an app, is only ever shown', () => {
    mkdirSync(join(root, 'Calc.app/Contents'), { recursive: true })
    expect(resolveLocal(join(root, 'Calc.app'), reach)?.kind).toBe('file')
  })

  it('limited: only its own folder and scratchpad', () => {
    const limited = { ...reach, limited: true }
    expect(resolveLocal(file('cliente-y/a.png'), limited)).toBeNull()
    expect(resolveLocal(file('dados/computers/ada/work/a.png'), limited)).not.toBeNull()
    expect(resolveLocal(file('tmp/claude/-Tucano-agents-ada/s/scratchpad/a.png'), limited)).not.toBeNull()
    expect(resolveLocal(file('tmp/claude/-Tucano-agents-theo/s/scratchpad/a.png'), limited)).toBeNull()
    expect(resolveLocal(file('tmp/outro/a.png'), limited)).toBeNull()
  })

  it('a link can’t reach out of its folder', () => {
    file('cliente-y/a.png')
    symlinkSync(join(root, 'cliente-y/a.png'), join(root, 'dados/computers/ada/work/atalho.png'))
    expect(resolveLocal(join(root, 'dados/computers/ada/work/atalho.png'), { ...reach, limited: true })).toBeNull()
  })

  it('`..` can’t climb out of its folder', () => {
    file('cliente-y/a.png')
    file('dados/computers/theo/work/b.png')
    const limited = { ...reach, limited: true }
    expect(resolveLocal(join(root, 'dados/computers/ada/work') + '/../../../../cliente-y/a.png', limited)).toBeNull()
    expect(resolveLocal(join(root, 'dados/computers/ada/work') + '/../../theo/work/b.png', reach)).toBeNull()
  })

  it('an agent with no computer, or on Linux, is limited; only one on this computer isn’t', () => {
    expect(isLimited({ computer: false })).toBe(true)
    expect(isLimited({})).toBe(true)
    expect(isLimited({ computer: false, computerKind: 'mac' })).toBe(true)
    expect(isLimited({ computer: true, computerKind: 'linux' })).toBe(true)
    expect(isLimited({ computer: true, computerKind: 'mac' })).toBe(false)
  })

  it('never the app’s data, another agent’s folder or a place that holds logins', () => {
    expect(resolveLocal(file('dados/tucano.db'), reach)).toBeNull()
    expect(resolveLocal(file('dados/computers/theo/work/a.png'), reach)).toBeNull()
    expect(resolveLocal(file('casa/.ssh/id_rsa'), reach)).toBeNull()
    expect(resolveLocal(file('casa/.aws/credentials'), reach)).toBeNull()
    chmodSync(root, 0o755)
  })

  it('expands the home folder', () => {
    expect(resolveLocal('~/p/a.png', reach, (file('p/a.png'), root))?.kind).toBe('image')
  })

  it('an address only opens what was signed', () => {
    const url = new URL(localUrl('chave', '/tmp/a.png'))
    expect(url.host).toBe('local')
    expect(verifyLocalUrl('chave', url)).toBe('/tmp/a.png')
    expect(verifyLocalUrl('outra', url)).toBeNull()
    const [sig] = url.pathname.slice(1).split('/')
    expect(verifyLocalUrl('chave', new URL(`tucano://local/${sig}/${Buffer.from('/etc/passwd').toString('base64url')}`))).toBeNull()
  })
})

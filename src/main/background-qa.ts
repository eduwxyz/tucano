import { readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export interface BackgroundOptions {
  background: boolean
  qa: boolean
  ports?: { webhookPort: number; gitPort: number }
}

// Hidden QA must fail before startup can open a database or register a service.
export function backgroundOptions(argv: string[], env: NodeJS.ProcessEnv, protectedDirs: string[], protectedPorts: number[]): BackgroundOptions {
  const qa = argv.includes('--qa-background')
  if (!qa) return { background: argv.includes('--background'), qa: false }
  const data = env['TUCANO_DATA']
  if (!data || !isAbsolute(data)) throw new Error('Background QA requires an absolute, empty TUCANO_DATA directory')
  const canonical = realpathSync(data)
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!path.startsWith('..') && !isAbsolute(path))
  }
  for (const dir of protectedDirs) {
    let protectedPath = resolve(dir)
    try { protectedPath = realpathSync(protectedPath) } catch { /* The normal profile may not exist yet. */ }
    if (contains(protectedPath, canonical) || contains(canonical, protectedPath)) throw new Error('Background QA cannot use an application profile')
  }
  if (readdirSync(canonical).length) throw new Error('Background QA requires an empty TUCANO_DATA directory')
  if (env['TUCANO_FAKE_ENGINES'] !== '1') throw new Error('Background QA requires fake engines')
  const values = [env['TUCANO_WEBHOOK_PORT'], env['TUCANO_GIT_PORT']]
  const ports = values.map((value) => value && /^\d+$/.test(value) ? Number(value) : NaN)
  if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || protectedPorts.includes(port)) || ports[0] === ports[1]) throw new Error('Background QA requires two distinct ports outside normal application ports')
  return { background: true, qa: true, ports: { webhookPort: ports[0]!, gitPort: ports[1]! } }
}

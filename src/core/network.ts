// Company networks, where a connector would otherwise fail with "fetch failed". A proxy or an
// antivirus that inspects HTTPS signs every site again with a root of its own, which the system
// trusts (IT or the antivirus installed it) but Node's bundled list doesn't; and the system's proxy
// (macOS or Windows network settings, a PAC) is one Node never asks about. So the core trusts the
// system's certificates as well as Node's, and sends its own requests (fetch, https) through the
// proxy the environment names, or the system's, that the app resolves (src/main). Certificates are
// still checked, always: this only adds roots the system already trusts.
import * as http from 'node:http'
import * as tls from 'node:tls'

type CaApi = {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

// Adds the system's roots (Keychain, the Windows store, /etc/ssl) to the ones Node trusts; how many
// were new. Nothing on a Node without the API (older than 22.19/23.9), or when the system says nothing.
export function trustSystemCertificates(api: CaApi = tls as CaApi): number {
  if (!api.getCACertificates || !api.setDefaultCACertificates) return 0
  try {
    const now = api.getCACertificates('default')
    const known = new Set(now)
    const added = api.getCACertificates('system').filter((c) => !known.has(c))
    if (added.length) api.setDefaultCACertificates([...now, ...added])
    return added.length
  } catch (e) {
    console.error('[network] system certificates', e)
    return 0
  }
}

// What Chromium answers for an address ("PROXY host:port; DIRECT", "HTTPS host:port", "DIRECT") as a
// proxy URL Node takes: the first HTTP(S) one. SOCKS isn't one Node speaks, so it's left out.
export function proxyFromPac(answer: string): string | undefined {
  for (const part of answer.split(';')) {
    const m = /^\s*(PROXY|HTTPS)\s+(\S+)\s*$/i.exec(part)
    if (m) return `${m[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`
    if (/^\s*DIRECT\s*$/i.test(part)) return undefined
  }
  return undefined
}

// This machine, never through a proxy: the gateway, the agents' Chrome, the webhook.
const LOCAL = ['localhost', '127.0.0.1', '::1']

// The proxy settings the core's requests use: HTTPS_PROXY / HTTP_PROXY (or ALL_PROXY), lower case too,
// then the system's (TUCANO_SYSTEM_PROXY, from the app). Undefined when there's none.
export function proxyEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const pick = (...keys: string[]): string | undefined => keys.map((k) => env[k]?.trim()).find((v) => !!v)
  const all = pick('ALL_PROXY', 'all_proxy')
  const anyHttp = all && /^https?:\/\//i.test(all) ? all : undefined
  const system = pick('TUCANO_SYSTEM_PROXY')
  const https = pick('HTTPS_PROXY', 'https_proxy') ?? anyHttp ?? system
  const plain = pick('HTTP_PROXY', 'http_proxy') ?? anyHttp ?? system
  if (!https && !plain) return undefined
  const bypass = (pick('NO_PROXY', 'no_proxy') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    ...(https ? { HTTPS_PROXY: https } : {}),
    ...(plain ? { HTTP_PROXY: plain } : {}),
    NO_PROXY: [...new Set([...bypass, ...LOCAL])].join(',')
  }
}

type ProxyApi = { setGlobalProxyFromEnv?: (env: Record<string, string>) => unknown }

// Sends fetch and http(s) requests through the proxy, when there is one; the proxy used, for the log.
export function useProxy(env: NodeJS.ProcessEnv = process.env, api: ProxyApi = http as ProxyApi): string | undefined {
  const settings = proxyEnv(env)
  if (!settings || !api.setGlobalProxyFromEnv) return undefined
  try {
    api.setGlobalProxyFromEnv(settings)
    return (settings['HTTPS_PROXY'] ?? settings['HTTP_PROXY'])!.replace(/\/\/[^@/]*@/, '//…@') // no password in the log
  } catch (e) {
    console.error('[network] proxy', e)
    return undefined
  }
}

// Both, once, as the core starts.
export function companyNetwork(env: NodeJS.ProcessEnv = process.env): void {
  if (env['TUCANO_SYSTEM_CA'] !== '0') trustSystemCertificates()
  const proxy = useProxy(env)
  if (proxy) console.log(`[network] requests go through the proxy ${proxy}`)
}

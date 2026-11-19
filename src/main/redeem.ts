// A one-time code (`server.js pair`, Settings › Pessoas › Conectar um celular) traded for a key of
// this computer's own, as the phone does (src/server/pair-http.ts pairPost): the server spends the
// code and names the device from what we say. The key then signs in like the server's token does.
// No Electron here, so a test can trade one with a real server.
export type Redeemed = { key: string } | { error: 'used' | 'unreachable' }

const KEY = /^[A-Za-z0-9_-]{16,256}$/

export async function redeemCode(origin: string, code: string, device: { name: string; platform: string }, fetcher: typeof fetch = fetch): Promise<Redeemed> {
  let r: Response
  try {
    r = await fetcher(`${origin}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: device.name, platform: device.platform }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    return { error: 'unreachable' }
  }
  // 410: spent, past its time, or never made; 429: too many guesses from here. Either way, ask for a new one.
  if (r.status === 410 || r.status === 429) return { error: 'used' }
  if (!r.ok) return { error: 'unreachable' }
  const key = ((await r.json().catch(() => ({}))) as { key?: unknown }).key
  return typeof key === 'string' && KEY.test(key) ? { key } : { error: 'unreachable' }
}

// What this computer calls itself on the server's list of devices (Settings › People): its name,
// without the .local a Mac adds, and its system.
export function thisDevice(hostname: string, platform: NodeJS.Platform): { name: string; platform: string } {
  const name = hostname.replace(/\.local$/i, '').trim() || 'Tucano'
  return { name, platform: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform }
}

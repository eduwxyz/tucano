// A connector's secret (its token, a variable of its command) can be a 1Password reference instead of
// the value: op://Vault/Item/field. The app keeps only the reference; the value is read with the
// 1Password CLI on each connection, so it's never saved here, and 1Password asks you to unlock it.
import { execFile } from 'node:child_process'
import { L } from '../shared/lang'

export const isOpRef = (v: string | undefined): v is string => !!v && /^op:\/\/[^/]+\/[^/]+\/.+$/.test(v.trim())

// Time to unlock 1Password (Touch ID, the password) when it asks.
const READ_TIMEOUT_MS = 90_000

type Read = (ref: string) => Promise<string>

export class OpError extends Error {}

const opRead: Read = (ref) =>
  new Promise((resolve, reject) => {
    execFile('op', ['read', '--no-newline', ref], { timeout: READ_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      reject(new OpError(opMessage(err as NodeJS.ErrnoException & { killed?: boolean }, String(stderr), ref)))
    })
  })

// Why a reference wasn't read, and what to do.
export function opMessage(err: { code?: string | number; killed?: boolean; message?: string }, stderr: string, ref: string): string {
  if (err.code === 'ENOENT')
    return L(
      'Esse conector usa um segredo do 1Password, e o 1Password CLI (op) não foi encontrado. Instale (developer.1password.com/docs/cli) e ligue “Integrar com o 1Password CLI” nas configurações do app do 1Password.',
      'This connector uses a 1Password secret, and the 1Password CLI (op) wasn’t found. Install it (developer.1password.com/docs/cli) and turn on “Integrate with 1Password CLI” in the 1Password app’s settings.'
    )
  if (err.killed) return L('O 1Password não foi desbloqueado a tempo. Conecte de novo e desbloqueie quando ele pedir.', '1Password wasn’t unlocked in time. Connect again and unlock it when it asks.')
  const why = stderr.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/m, '').trim()
  if (/not (currently )?signed in|no accounts configured|sign in|authoriz/i.test(why))
    return L(
      'O 1Password CLI não está conectado à sua conta. Ligue “Integrar com o 1Password CLI” nas configurações do app do 1Password, ou rode op signin.',
      'The 1Password CLI isn’t signed in to your account. Turn on “Integrate with 1Password CLI” in the 1Password app’s settings, or run op signin.'
    )
  if (/isn't an item|not found|no item|could not find|isn't a vault|doesn't have a field/i.test(why))
    return L(`O 1Password não achou ${ref}. Confira o cofre, o item e o campo da referência.`, `1Password didn’t find ${ref}. Check the reference’s vault, item and field.`)
  return L(`O 1Password não leu ${ref}: ${why || err.message}`, `1Password didn’t read ${ref}: ${why || err.message}`)
}

export const resolveOp = async (v: string, read: Read = opRead): Promise<string> => (isOpRef(v) ? read(v.trim()) : v)

// Each value that's a reference, read; the others as they are.
export async function resolveOpRefs(values: Record<string, string>, read: Read = opRead): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) out[k] = await resolveOp(v, read)
  return out
}

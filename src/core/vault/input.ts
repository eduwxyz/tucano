// A vault item as a page sent it (anyone with a connection could send anything): back to its shape,
// or a message for the form. Vault.save checks the rest (names, hosts, values).
import { L } from '../../shared/lang'
import { VAULT_KINDS, type VaultAccess, type VaultItemInput, type VaultKind } from '../../shared/types'

const isStr = (v: unknown): v is string => typeof v === 'string'

export function vaultInput(raw: unknown): VaultItemInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bad = (): Error => new Error(L('Item do cofre inválido.', 'Invalid vault item.'))
  if (!isStr(o['name']) || !isStr(o['kind']) || !VAULT_KINDS.includes(o['kind'] as VaultKind)) throw bad()
  const a = (o['access'] && typeof o['access'] === 'object' ? o['access'] : {}) as Record<string, unknown>
  const access: VaultAccess = a['all'] === true ? { all: true } : { all: false, agentIds: Array.isArray(a['agentIds']) ? a['agentIds'].filter(isStr) : [] }
  const values = o['values'] && typeof o['values'] === 'object' ? Object.fromEntries(Object.entries(o['values'] as Record<string, unknown>).filter((e): e is [string, string] => isStr(e[1]))) : undefined
  return {
    ...(isStr(o['id']) && o['id'] ? { id: o['id'] } : {}),
    name: o['name'],
    kind: o['kind'] as VaultKind,
    description: isStr(o['description']) ? o['description'] : '',
    ...(values ? { values } : {}),
    access,
    hosts: Array.isArray(o['hosts']) ? o['hosts'].filter(isStr).slice(0, 20) : [],
    scope: o['scope'] === 'any' ? 'any' : 'http',
    askEachUse: o['askEachUse'] === true
  }
}

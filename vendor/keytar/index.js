// Not keytar. The Microsoft connector runs Softeria's ms-365-mcp-server inside Tucano (src/core/connectors.ts),
// and that server keeps its sign-in in a file it encrypts, with the 32-byte key in the system keychain
// through keytar. The real keytar is a native module built for Node, which Tucano's own runtime can't load,
// so this stands in for it: the key is the one Tucano keeps in its vault for that connector and hands the
// server in TUCANO_MS365_CACHE_KEY. The file alone (a copy, a backup) opens nothing.
// Only that one entry exists. Anything else reads as missing, and writing anything else fails, so the
// server never mints a key of its own here and never keeps a token outside the encrypted file.
'use strict'
const SERVICE = 'ms-365-mcp-server'
const ACCOUNT = 'cache-key'
const key = () => {
  const k = process.env.TUCANO_MS365_CACHE_KEY
  return k && k.trim() ? k.trim() : null
}
const ours = (service, account) => service === SERVICE && account === ACCOUNT

async function getPassword(service, account) {
  return ours(service, account) ? key() : null
}
async function setPassword(service, account, password) {
  if (ours(service, account) && password === key()) return
  throw new Error('Tucano keeps this key in its own vault: it is not written here.')
}
async function deletePassword() {
  return false
}
async function findCredentials(service) {
  const k = key()
  return service === SERVICE && k ? [{ account: ACCOUNT, password: k }] : []
}
async function findPassword(service) {
  return service === SERVICE ? key() : null
}

module.exports = { getPassword, setPassword, deletePassword, findCredentials, findPassword }

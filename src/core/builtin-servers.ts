// Servers Tucano carries inside itself, for connectors that would otherwise need Node.js installed: the
// Microsoft one (Softeria's ms-365-mcp-server, at the version in package.json). It runs on Tucano's own
// runtime: the app's executable as Node (ELECTRON_RUN_AS_NODE) on the desktop, node itself on a server.
//
// Its sign-in is kept the way the server keeps it, in a file it encrypts, but under this connector's own
// folder in the data folder, and with the key in Tucano's vault instead of the system keychain: the server
// reaches for keytar, a native module Tucano's runtime can't load, and finds vendor/keytar instead, which
// hands it the key this passes in TUCANO_MS365_CACHE_KEY. Each connector has its own folder and key, so a
// personal account and a work one, or two workspaces, never share a sign-in.
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isBuiltin } from '../shared/connector-catalog'

// Named apart from `require`: in the bundled core another module declares that name at the top.
const resolveFrom = createRequire(import.meta.url)

// Where the server's code is: inside the app (app.asar on the desktop), which its runtime reads as is.
export const ms365Entry = (): string => resolveFrom.resolve('@softeria/ms-365-mcp-server')

export interface Launch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

// A 32-byte key, as the server reads it (base64).
export const newCacheKey = (): string => randomBytes(32).toString('base64')

// The folder that holds what this connector's server keeps: its encrypted sign-in and its logs.
export const stateDir = (root: string, connectorId: string): string => join(root, connectorId)

// How a built-in connector starts. `runtime`: the executable that runs JavaScript (the app's own, or node).
export function builtinLaunch(c: { id: string; command: string; args: string[] }, o: { root: string; runtime: string; cacheKey: string; env: Record<string, string> }): Launch {
  if (!isBuiltin(c.command)) throw new Error(`Not a built-in server: ${c.command}`)
  const dir = stateDir(o.root, c.id)
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 })
  return {
    command: o.runtime,
    args: [ms365Entry(), ...c.args],
    env: {
      ...o.env,
      ELECTRON_RUN_AS_NODE: '1',
      TUCANO_MS365_CACHE_KEY: o.cacheKey,
      MS365_MCP_TOKEN_CACHE_PATH: join(dir, 'token-cache.json'),
      MS365_MCP_SELECTED_ACCOUNT_PATH: join(dir, 'selected-account.json'),
      MS365_MCP_LOG_DIR: join(dir, 'logs')
    },
    // Its own folder: the server reads a .env from where it starts, and nothing stray should reach it.
    cwd: dir
  }
}

// Removing the connector takes its sign-in with it.
export function forgetBuiltin(root: string, connectorId: string): void {
  rmSync(stateDir(root, connectorId), { recursive: true, force: true })
}

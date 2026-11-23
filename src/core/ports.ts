// mcp: where the desktop answers MCP for the person's harnesses (src/core/mcp-http.ts), on 127.0.0.1 only.
// The app gives each workspace its webhook port + 100 (src/main/index.ts).
export function workspacePorts(env: NodeJS.ProcessEnv = process.env): { webhook: number; git: number; mcp: number } {
  const read = (key: string, fallback: number): number => {
    const port = env[key] === undefined ? fallback : Number(env[key])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${key}`)
    return port
  }
  const webhook = read('TUCANO_WEBHOOK_PORT', 47717)
  const git = read('TUCANO_GIT_PORT', 47718)
  const mcp = read('TUCANO_MCP_PORT', webhook + 100)
  if (webhook === git || mcp === webhook || mcp === git) throw new Error('Workspace ports must be different')
  return { webhook, git, mcp }
}

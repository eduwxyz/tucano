export function workspacePorts(env: NodeJS.ProcessEnv = process.env): { webhook: number; git: number } {
  const read = (key: string, fallback: number): number => {
    const port = env[key] === undefined ? fallback : Number(env[key])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${key}`)
    return port
  }
  const webhook = read('TUCANO_WEBHOOK_PORT', 47717)
  const git = read('TUCANO_GIT_PORT', 47718)
  if (webhook === git) throw new Error('Workspace ports must be different')
  return { webhook, git }
}

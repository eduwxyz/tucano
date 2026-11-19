// Which quota a bot draws on. A model id names its harness first ("pi:opencode-go/deepseek-v4.1-flash",
// "codex:gpt-6.1-sol") and, inside a harness that hosts several, the login it runs on: that login is
// the provider whose quota runs out. Read here so a header can show the bars of the providers this bot
// actually spends, instead of every login on the computer.
//
// A harness with its own subscription needs no login named in the id: Codex is OpenAI Codex, Claude
// Code is Anthropic's, Grok CLI is xAI's, OpenCode's subscription is OpenCode Go. Anything else (a
// harness that hosts anything, a wallet with no subscription) names no provider, and the caller draws
// nothing rather than a guess.
import { modelInfo, type Account } from './types'

// What a harness or a login inside one calls a provider, and what the quota reader calls it.
const BY_TOKEN: Record<string, string> = {
  codex: 'openai-codex',
  'openai-codex': 'openai-codex',
  claude: 'anthropic-claude-code',
  anthropic: 'anthropic-claude-code',
  'anthropic-claude-code': 'anthropic-claude-code',
  'opencode-go': 'opencode-go',
  opencode: 'opencode-go',
  zai: 'zai',
  grok: 'xai-oauth',
  xai: 'xai-oauth',
  'xai-oauth': 'xai-oauth',
  copilot: 'github-copilot',
  '/copilot': 'github-copilot',
  'github-copilot': 'github-copilot',
  openrouter: 'openrouter',
  deepseek: 'deepseek'
}

// A harness whose whole subscription is one provider's.
const BY_ENGINE: Record<string, string> = {
  codex: 'openai-codex',
  claude: 'anthropic-claude-code',
  grok: 'xai-oauth',
  opencode: 'opencode-go'
}

/**
 * The provider one model id draws on: the login's engine when the bot names a login, otherwise the
 * harness named before the colon, otherwise the login the harness hosts (from the id's own segment).
 */
export function providerOf(modelId: string | undefined, accounts: Account[] = [], accountId?: string): string | undefined {
  const login = accountId ? accounts.find((a) => a.id === accountId) : undefined
  const fromLogin = login ? BY_ENGINE[login.engine] : undefined
  if (fromLogin) return fromLogin
  if (!modelId) return undefined
  const colon = modelId.indexOf(':')
  const engine = colon > 0 ? modelId.slice(0, colon) : modelInfo(modelId)?.engine
  const rest = colon > 0 ? modelId.slice(colon + 1) : modelId
  const slash = rest.indexOf('/')
  // "pi:opencode-go/deepseek-v4.1-flash": the segment between the harness and the model is the login.
  const hosted = slash > 0 ? BY_TOKEN[rest.slice(0, slash).toLowerCase()] : undefined
  if (hosted) return hosted
  return engine ? BY_ENGINE[engine] : undefined
}

/**
 * The providers the bots in a conversation spend, main model first and its fallback next, in the order
 * the conversation lists them. Two at most: a header has room for the two that a reply will actually
 * try, and the Usage page lists the rest.
 */
export function agentProviders(
  agents: { modelId?: string; fallbackModelId?: string; accountId?: string; fallbackAccountId?: string }[],
  accounts: Account[] = [],
  max = 2
): string[] {
  const out: string[] = []
  for (const a of agents) {
    for (const id of [providerOf(a.modelId, accounts, a.accountId), providerOf(a.fallbackModelId, accounts, a.fallbackAccountId)]) {
      if (id && !out.includes(id)) out.push(id)
      if (out.length >= max) return out
    }
  }
  return out
}

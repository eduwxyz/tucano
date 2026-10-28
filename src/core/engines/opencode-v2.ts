import { existsSync } from 'node:fs'
import { GATEWAY_NAME } from './claude'
import type { Turn } from './types'

// OpenCode 2 kept the `opencode` command, the config dir and OPENCODE_CONFIG_CONTENT,
// but changed its config to native V2 shapes (agents with system instead of the
// singular agent with prompt, mcp.servers, update, snapshots) and moved from a
// standalone process to a client-server model. `--standalone` takes the place V1's
// `--pure` had: every turn runs against a private server of its own, so the app's
// isolated dirs stay self-contained and the run never fights the person's own
// OpenCode over the shared service's port. The user's provider block passes
// through as-is: V2 normalizes V1 `provider` maps in memory.
export function opencodeV2Config(turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, providers: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    ...providers,
    share: 'disabled',
    update: 'disable',
    snapshots: false,
    mcp: turn.mcpUrl ? { servers: { [GATEWAY_NAME]: { type: 'remote', url: turn.mcpUrl, disabled: false } } } : {},
    tools: { '*': false, [`${GATEWAY_NAME}_*`]: true, webfetch: !!turn.web, websearch: !!turn.web },
    agents: { tucano: { system: turn.system } }
  }
}

export function opencodeV2Args(turn: Pick<Turn, 'model' | 'images'>): string[] {
  return ['run', '--standalone', '--format', 'json', '--agent', 'tucano', '-m', turn.model, ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => ['-f', i.path])]
}

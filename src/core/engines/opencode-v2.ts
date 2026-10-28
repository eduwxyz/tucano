import { existsSync } from 'node:fs'
import { GATEWAY_NAME } from './claude'
import { runCli } from './cli'
import { opencodeHome, opencodeParser, userOpencodeProviders } from './opencode'
import type { Engine, Turn } from './types'
import { L } from '../../shared/lang'

// OpenCode 2 kept the `opencode` command, the config dir and OPENCODE_CONFIG_CONTENT,
// but changed its config to native V2 shapes (agents with system instead of the
// singular agent with prompt, mcp.servers, update, snapshots) and moved from a
// standalone process to a client-server model. `--standalone` takes the place V1's
// `--pure` had: every turn runs against a private server of its own, so the app's
// isolated dirs stay self-contained and the run never fights the person's own
// OpenCode over the shared service's port. The user's provider block passes
// through as-is: V2 normalizes V1 `provider` maps in memory. The V1 `tools` block
// keeps working too: the canary against v2.2.0 confirmed the shell stays denied
// with `'*': false` and the system prompt arrives through `agents`.
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

// The same shape as the V1 engine: the JSONL parser is shared because V2's
// `run --format json` kept the same events (step_start, text, tool_use,
// step_finish, error) and part shapes; only the config and args differ above.
export function opencodeV2Engine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'opencode-v2',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O OpenCode V2 não está instalado. Veja em Configurações.', "OpenCode V2 isn't installed. See Settings.") }
        return
      }
      // Provider keys may live in the user's shell, which an app opened from Finder doesn't get.
      const env = { ...process.env, ...(await shellEnv()), ...opencodeHome(appDir), OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeV2Config(turn, userOpencodeProviders())) }
      yield* runCli({ bin: path, args: opencodeV2Args(turn), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: opencodeParser(), env })
    }
  }
}

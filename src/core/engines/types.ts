import type { CodexQuota, Effort, EngineId, Quota } from '../../shared/types'

export interface Turn {
  model: string
  effort: Effort
  system: string
  prompt: string
  blocks?: string[] // the same prompt in pieces (one per message), so an engine that caches by block reuses the conversation
  images?: TurnImage[] // images attached to messages of the conversation, the newest ones
  cwd: string // an empty per-agent directory; the CLI gets no project files
  agentKey?: string // stable per-agent identity: an engine that keeps per-agent state (Hermes) names its files with it
  signal: AbortSignal
  mcpUrl?: string // the app's gateway for this turn: the only tools the CLI gets, besides the web ones
  web?: boolean // the CLI's own web search and page reading
  account?: string // the folder of another login of this harness (Settings › Accounts); unset: its usual one
  // A session the engine keeps on disk: `resume` false starts it with this id,
  // true goes on from it, and then `blocks` hold only what's new since its last reply. `keep`: the
  // process may stay open a few minutes after the reply, for the next one.
  session?: { id: string; resume: boolean; keep?: boolean }
}

// An image file, shown to the model right after block `block` (the message it came with).
export interface TurnImage {
  block: number
  path: string
  mime: string
}

export interface Usage {
  inputTokens: number // everything sent, including cache reads
  cacheReadTokens: number
  outputTokens: number
  apiCostUsd?: number
}

export type EngineEvent =
  | { type: 'text'; delta: string }
  // Running total for the turn so far (everything sent, cache reads included, plus output)
  // and how much of it came from the cache, used to enforce limits mid-turn.
  | { type: 'progress'; tokens: number; cacheRead?: number }
  // A web search or page read the CLI did on its own (not through the gateway).
  | { type: 'web'; action: 'search' | 'fetch'; detail: string }
  | { type: 'quota'; quota: Quota } // the subscription's usage windows, when the CLI tells
  // `context`: the tokens the last model call of the turn saw, its reply included (how big a kept session is).
  | { type: 'done'; text: string; usage: Usage; context?: number }
  | { type: 'error'; message: string }

// A turn's settings without what it says: enough to start its process ahead of time.
export type TurnShape = Omit<Turn, 'prompt' | 'blocks' | 'images' | 'signal' | 'session'>

export interface Engine {
  id: EngineId
  run(turn: Turn): AsyncIterable<EngineEvent>
  sessions?: boolean // takes `turn.session`; without it, every turn gets the whole conversation
  // Its own daemon keeps the MCP connection from one turn to the next, so the URL it gets has to
  // outlive the turn: the runner hands it a token that stays the same (Hermes' gateway daemon).
  keepsMcp?: boolean
  release?(sessionId: string): void // a session that won't be resumed: its process and its file go
  clean?(workDir: string, accountDirs?: string[]): void // sessions left from an earlier run of the app, by agents under workDir
  dispose?(): void // the app is quitting: processes kept open close
  planUsage?(): Promise<CodexQuota | undefined> // the usual login's subscription windows, when the CLI tells
  settle?(): Promise<void> // the files of sessions let go are gone (their processes write on their way out)
  // Starting the CLI takes about a second before any model call; these do it ahead of time.
  warm?(turn: TurnShape): void // a process ready for the next turn with these settings and no session (the router's)
  rewarm?(sessionId: string): void // the session's process again, if it closed, ready for its next turn
}

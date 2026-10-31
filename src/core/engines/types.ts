import type { Effort, EngineId, Quota } from '../../shared/types'

export interface Turn {
  model: string
  effort: Effort
  system: string
  prompt: string
  blocks?: string[] // the same prompt in pieces (one per message), so an engine that caches by block reuses the conversation
  images?: TurnImage[] // images attached to messages of the conversation, the newest ones
  cwd: string // an empty per-agent directory; the CLI gets no project files
  agentKey?: string // stable per-agent identity (the agent's own directory name), so an engine that keeps per-agent state can
  signal: AbortSignal
  mcpUrl?: string // the app's gateway for this turn: the only tools the CLI gets, besides the web ones
  web?: boolean // the CLI's own web search and page reading
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
  | { type: 'done'; text: string; usage: Usage }
  | { type: 'error'; message: string }

export interface Engine {
  id: EngineId
  run(turn: Turn): AsyncIterable<EngineEvent>
}

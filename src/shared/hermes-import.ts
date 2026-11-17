// Importing from Hermes Agent (Nous Research), spec §26: the contract between the core, which reads
// the Hermes folder (~/.hermes, $HERMES_HOME, or one the person picks), and the screen that shows
// what comes in before anything is added. Nothing is added by `hermesPreview`; `importHermes` adds
// the chosen profiles the same way as OpenBot's (no connector, web off, no computer, routines off,
// memories waiting for confirmation).

// One Hermes profile: the main one ("default", the folder itself) or one of profiles/<name>/.
// Each one becomes one agent.
export interface HermesProfile {
  key: string // "default", or the folder name under profiles/
  name: string // the agent's name here
  instructions: boolean // has a SOUL.md
  memories: number // from memories/MEMORY.md, after the caps
  userMemories: number // from memories/USER.md, after the caps
  skills: number // after the caps
  routines: number // cron jobs that fit a schedule here (they come in off)
  routinesAsNames: string[] // cron jobs whose schedule doesn't fit here: only named in the summary
}

export interface HermesPreview {
  path: string // the folder that was read
  profiles: HermesProfile[] // at least one
  // What stays only as a name in the summary, to set up by hand here.
  servers: string[] // MCP servers
  gateways: string[] // Telegram, Discord, Slack…
  models: string[] // the model / provider it used
  notes: string[] // what else stays out, and why (sessions, history, logs, caps…)
}

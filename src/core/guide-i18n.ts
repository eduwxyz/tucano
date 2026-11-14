// The guide's pages are written in Portuguese: they are the app's own manual, and translating all 23
// bodies is a decision for the person who owns the words (see the issue). What a model *always* sees,
// though, is the index of them, on every message, in the Tuca's prompt: 3,771 characters of
// Portuguese titles and summaries in an English workspace. This table is that index in English.
//
// One entry per page in src/core/guide/. A page with no entry here is a page the English prompt would
// still show in Portuguese, so test/guide-i18n.test.ts fails on a slug that exists in one and not the
// other, in either direction.
export const GUIDE_EN: Record<string, { title: string; summary: string }> = {
  agentes: {
    title: 'Agents',
    summary: 'Creating an agent, instructions, model, limits, tools and access, memory, appearance and archiving.'
  },
  aprovacoes: {
    title: 'Approvals',
    summary: 'What waits for your ok, how to decide, always allow, high-risk actions and expiry.'
  },
  backup: {
    title: 'Team, import and backups',
    summary: 'Exporting and importing the team as a .md file, bringing agents over from OpenBot or Grok Bot, and the database backups.'
  },
  celular: {
    title: 'Phone (iPhone and Telegram)',
    summary: 'The Tucano app on the iPhone, over the home Wi-Fi; or approvals, questions and the end of routines in your Telegram, with a bot of your own.'
  },
  comecar: {
    title: 'Starting on Tucano',
    summary: 'What Tucano is, the introduction, the Tuca, the sidebar and the Settings tabs.'
  },
  composio: {
    title: 'Composio: hundreds of apps through a third party',
    summary: 'The Composio connector: what it gives, the price in privacy (your data passes through its servers), how to connect and why every action asks for approval.'
  },
  computadores: {
    title: 'Computer, folders, GitHub and browser',
    summary: "Where an agent runs commands (an isolated Linux or this computer), lent folders, services left running and the agent's browser."
  },
  conectores: {
    title: 'Connectors',
    summary: 'Connecting Tucano to your tools (Linear, GitHub, Notion…) over MCP: the store, the custom ones, sign-in, tool classes and errors.'
  },
  conversas: {
    title: 'Conversations, channels and threads',
    summary: 'Channels, direct messages, threads, mentions, who answers, passing the turn between agents, stop and try again, images and dictation.'
  },
  google: {
    title: 'Google: Gmail, Calendar, Drive, Docs and Sheets',
    summary: 'Connecting the Google services: the app the person creates in Google Cloud once, the 6 steps (with the Developer Preview enrolment), the unverified-app warning and what to check when Google refuses.'
  },
  limites: {
    title: 'Limits, usage and pause',
    summary: "Each agent's monthly limit, the ceiling per reply, when a reply is cut, Usage and limits, Report, pausing everything and quiet hours."
  },
  memoria: {
    title: 'Memory',
    summary: "What the agents know about you: how they learn, approve or leave it automatic, each agent's notes and the summary of long conversations."
  },
  motores: {
    title: 'Harnesses and accounts',
    summary: 'Where the agents run: the harnesses, how to sign in, extra accounts, the company gateway and the Jev router.'
  },
  problemas: {
    title: 'When something goes wrong',
    summary: "Diagnosing the common problems: an agent that doesn't answer, a harness without a sign-in, a connector asking for sign-in or failing, Docker off, limits, a routine that didn't run, an expired approval, a notification that doesn't arrive."
  },
  rede: {
    title: 'Company network, proxy and antivirus',
    summary: "A connector that only fails on one network: a certificate that isn't accepted (a proxy or antivirus inspecting HTTPS), proxy, DNS, firewall, and what to do in each case."
  },
  rotinas: {
    title: 'Routines',
    summary: 'An agent working on its own: at a time, when something new appears in a connector, or when called on this computer.'
  },
  servidor: {
    title: 'Tucano on a server',
    summary: 'Running Tucano on a server of your own (a VPS or a machine at home) and using it through the browser: installing, reaching it, keeping it running and what changes.'
  },
  skills: {
    title: 'Skills',
    summary: "Recipes the agents follow for a kind of task: writing one, bringing one from Claude Code or Codex, approving the agents' proposals and going back to a version."
  },
  slack: {
    title: 'Slack',
    summary: "Connecting Slack: the internal app the person creates from a link, the 2 steps, the admin's approval and what to check when it doesn't connect."
  },
  time: {
    title: 'Team (several people in one Tucano)',
    summary: 'Using the same Tucano with other people: inviting, roles, what belongs to whom, For you, calling a person, who covers for me, routines, Activity, removing someone and the first invite.'
  },
  'wiki-git': {
    title: 'Wiki in git',
    summary: 'The wiki folder kept in a git repository (the Obsidian vault on GitHub, for example): connecting with a deploy key, what syncs, conflicts, read only, and Obsidian Git on the Mac.'
  },
  wiki: {
    title: 'Wiki',
    summary: 'What you and the team know, in linked pages: writing, importing from Obsidian, the curator that keeps it from the conversations, approving changes and the review.'
  },
  workspaces: {
    title: 'Workspaces',
    summary: 'Separating contexts (company and personal, for example): creating one choosing what to carry over, switching, duplicating, pausing, deleting, and what stays shared on the computer.'
  }
}

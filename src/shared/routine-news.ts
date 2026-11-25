import { L } from './lang'
import type { Run } from './types'

// A routine that looks at something every hour mostly finds nothing. Its run is told to answer
// one fixed phrase then, so the core can mark the reply (Run.noNews) and the conversation folds
// those runs into one line instead of guessing from whatever the agent wrote.
export const noNewsPhrase = (): string => L('Sem novidade.', 'Nothing new.')

// The phrase in either language, whatever the case, accents, punctuation or formatting around it
// ("**Sem novidade.**", "sem novidades", "Nothing new"). Anything more than that is news.
const PHRASES = new Set(['sem novidade', 'sem novidades', 'nothing new'])
export function isNoNews(text: string): boolean {
  const plain = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return PHRASES.has(plain)
}

// A routine's reply that is only the phrase: nothing asked, nothing waiting, nothing made or handed on.
// Anything that came with it is something the person should see.
export function noNewsRun(text: string, run: Pick<Run, 'status' | 'question' | 'questions' | 'approvalId' | 'artifactIds' | 'memoryIds' | 'routineIds' | 'services' | 'delegations' | 'proposals' | 'proposal' | 'agentDraft' | 'error'>): boolean {
  if (run.status !== 'done' || run.error || run.question || run.questions?.length || run.approvalId) return false
  if (run.artifactIds?.length || run.memoryIds?.length || run.routineIds?.length || run.services?.length || run.delegations?.length || run.proposals?.length || run.proposal || run.agentDraft) return false
  return isNoNews(text)
}

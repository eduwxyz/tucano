// Read-only sweep of the daily-driver database: what the detector does with the phrasings agents
// actually wrote. This test records evidence and writes a JSON report; it never opens the DB for
// writing and it never changes a run.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { oneActionProposal } from '../src/shared/proceed'

const DB_PATH = 'C:/git-ext/tucano-wt/daily-driver/profile/tucano.db'
const OUT = 'C:/tmp/frames/proceed-verification/real-phrases.json'

// Words that make a reply worth reading as an offer, including the ones the detector misses.
const HINT = /say the word|at your word|just say (?:yes|so)|if you want|if you(?:'|’)d like|if you would like|want me to|do you want me to|would you like me to|your call|if you say so|just tell me to|tell me to|let me know if|shall i|say so and i|ready when you are|se quiser|se você quiser|se quiseres|quando quiser|quando você quiser|quando você mandar|só me avisar|só me dizer|só dizer|só pedir|é só dizer|diga sim|me avise|você decide|fico no aguardo|se permitir|se eu puder|posso eu|quer que eu|no seu tempo/i

type Row = { id: string; text: string; at: number; conversation_id: string; storedProceed: boolean }

describe('real-phrase sweep', () => {
  it('feeds actual agent phrasings through the detector and records the verdicts', () => {
    expect(existsSync(DB_PATH), `missing read-only source ${DB_PATH}`).toBe(true)
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const rows = db.prepare("SELECT id, text, at, conversation_id, run FROM messages WHERE author_kind = 'agent' AND text IS NOT NULL").all() as {
      id: string; text: string; at: number; conversation_id: string; run: string | null
    }[]
    db.close()

    const all: Row[] = rows.map((r) => ({
      id: r.id,
      text: r.text,
      at: r.at,
      conversation_id: r.conversation_id,
      storedProceed: !!r.run && /"proceedOpen"\s*:\s*true/.test(r.run)
    }))
    const hinted = all.filter((r) => HINT.test(r.text))
    const accepted = all.flatMap((r) => {
      const hit = oneActionProposal(r.text)
      return hit ? [{ ...r, paragraph: hit.paragraph }] : []
    })
    const missed = hinted.filter((r) => !oneActionProposal(r.text))

    const snippet = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 260)
    const compact = (r: Row & { paragraph?: string }) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      text: snippet(r.text),
      ...(r.paragraph ? { paragraph: snippet(r.paragraph) } : {}),
      storedProceed: r.storedProceed
    })
    // A spread over time, not just the newest messages, with the oldest and newest kept.
    const spread = <T>(items: T[], max: number): T[] => {
      if (items.length <= max) return items
      return Array.from({ length: max }, (_, i) => items[Math.floor((i * (items.length - 1)) / (max - 1))]!)
    }

    const action = /(?:i(?:['’]ll| will| can| could| would)|let me|vou|posso|faço|faria|deixo|leio|abro|escrevo|rode|trago|monto|preparo|instalo|configuro|checo)/gi
    const actionsOf = (s: string): number => [...s.matchAll(action)].length
    const suspect = {
      negation: accepted.filter((r) => /\b(?:won't|will not|não vou|never|do not)\b/i.test(r.paragraph)),
      optionsQuestion: accepted.filter((r) => /\?[^\n]*\bor\b/i.test(r.paragraph)),
      genericOffer: accepted.filter((r) => /let me know if|if you'd rather|if you want it|nothing from you|no need from you/i.test(r.paragraph)),
      multipleActions: accepted.filter((r) => actionsOf(r.paragraph) > 1)
    }

    const report = {
      source: DB_PATH,
      openedReadOnly: true,
      agentMessages: all.length,
      messagesWithInvitationHint: hinted.length,
      detectorAccepted: accepted.length,
      detectorAcceptedWithHint: accepted.filter((r) => HINT.test(r.text)).length,
      storedProceedButtons: all.filter((r) => r.storedProceed).length,
      acceptedSpread: spread(accepted, 60).map(compact),
      acceptedWithQuestionMark: accepted.filter((r) => /\?/.test(r.text)).slice(0, 30).map(compact),
      suspectCounts: Object.fromEntries(Object.entries(suspect).map(([k, v]) => [k, v.length])),
      suspectExamples: Object.fromEntries(Object.entries(suspect).map(([k, v]) => [k, v.slice(0, 12).map(compact)])),
      missedHintedSpread: spread(missed, 60).map(compact),
      missedReadyWhenYouAre: missed.filter((r) => /ready when you are/i.test(r.text)).slice(0, 15).map((r) => {
        const i = r.text.toLowerCase().indexOf('ready when you are')
        return { id: r.id, context: r.text.replace(/\s+/g, ' ').slice(Math.max(0, i - 120), i + 220) }
      }),
      notableAcceptedFull: accepted.filter((r) => ['87d576d7-bd77-448a-b009-cf1866783977', '4e174d8e-5909-4bff-8391-8954edf6640a', 'f2c5e960-317a-4968-8b63-0d2331b6ff83'].includes(r.id)).map((r) => ({ id: r.id, paragraph: r.paragraph }))
    }
    mkdirSync(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true })
    writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({
      agentMessages: report.agentMessages,
      messagesWithInvitationHint: report.messagesWithInvitationHint,
      detectorAccepted: report.detectorAccepted,
      detectorAcceptedWithHint: report.detectorAcceptedWithHint,
      storedProceedButtons: report.storedProceedButtons,
      missedHinted: missed.length
    }))
    expect(report.agentMessages).toBeGreaterThan(0)
  })
})

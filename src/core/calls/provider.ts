// The boundary of a voice service: only what differs between one and another. Everything else about
// a call (who answers, the limits, the card, what is agreed) lives in index.ts and is the same for
// any service. A second service is one more file that implements this, never a setting.
import type { CallSetupStep, CallTurn, VoiceOption, VoiceProviderId } from '../../shared/calls'

// What `prepare` made at the service for one number: kept sealed with the number, so it can be found,
// updated and removed later.
export interface ProviderState {
  agentId: string
  phoneNumberId: string
  toolIds: string[]
  secretIds: string[]
}

// The dynamic variables the attendant reads for the call's prompt and first sentence. A call the service starts
// by itself (inbound) gets both from the "a call is starting" answer; a call Tucano places (outbound) can only
// carry variables, so the attendant is written in terms of them.
export const PROMPT_VAR = 'tucano_prompt'
export const FIRST_VAR = 'tucano_first_message'

export interface PrepareInput {
  number: string // +E.164
  label: string
  sipUser: string // what Meta answers a digest challenge with: the number in digits
  sipPassword: string
  urls: { start: string; tool: string } // `tool` is the base: the tool's name is added to it
  secrets: { start: string; tool: string } // sent by the service in the header `x-tucano-secret`
  maxSeconds: number
  known?: ProviderState // what an earlier run made for this number, to be found again instead of duplicated
  onStep?(s: CallSetupStep): void
}

export interface VoiceProvider {
  id: VoiceProviderId
  // The service's SIP server, which Meta is told to send the calls to.
  sip: { hostname: string; port: number }
  // Makes (or finds) the one attendant, its three tools and the trunk for this number; idempotent.
  prepare(p: PrepareInput): Promise<ProviderState>
  update(state: ProviderState, p: { maxSeconds: number }): Promise<void>
  teardown(state: ProviderState): Promise<void> // removes the trunk number; the attendant stays, other numbers may use it
  voices(q?: string): Promise<VoiceOption[]>
  // Reads the service's "a call is starting" request and writes the answer in its format.
  readStart(body: unknown): { conversationId: string; caller: string; called: string } | undefined
  startReply(p: { prompt: string; firstMessage: string; language: string; voiceId?: string; toolIds: string[]; variables: Record<string, string>; maxSeconds?: number }): unknown
  readTool(body: unknown): { conversationId: string; args: Record<string, unknown> } | undefined
  // The call afterwards; undefined while it is still going on.
  result(conversationId: string): Promise<{ seconds: number; summary?: string; turns: CallTurn[] } | undefined>
  // `voiceId`: the voice this one call speaks with, when the agent that calls has one.
  dial(state: ProviderState, p: { to: string; variables: Record<string, string>; voiceId?: string }): Promise<{ conversationId?: string }>
}

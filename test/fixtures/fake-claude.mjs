// Stands in for Claude Code reading `--input-format stream-json`: one reply per message on stdin,
// for as long as stdin stays open. The reply says which process and which turn it was, and whether
// it was started to resume a session, and how long the process had been up. "demore" in the
// message: it takes 5 s before answering. Plain text on stdin (no --input-format) is one message.
import { createInterface } from 'node:readline'

const resume = process.argv.includes('--resume')
let turn = 0
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`)

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    msg = { message: { content: [{ text: line }] } }
  }
  const text = (msg.message?.content ?? []).map((c) => c.text ?? '').join('\n')
  turn++
  out({ type: 'system', subtype: 'init' })
  out({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 0 } } } })
  if (/demore/.test(text)) await new Promise((r) => setTimeout(r, 5000))
  const reply = `pid=${process.pid} turn=${turn} resume=${resume} up=${Math.round(process.uptime() * 1000)}`
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } })
  out({ type: 'result', subtype: 'success', result: reply, usage: { input_tokens: 10, output_tokens: 5 } })
})

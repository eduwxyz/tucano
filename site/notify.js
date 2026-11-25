// Telling the owner something happened: an email (Resend) and a push on the phone (Grafana IRM, a
// "formatted webhook" integration whose escalation notifies the owner's app). Each one is optional,
// on when its secrets are set:
//   npx wrangler secret put RESEND_API_KEY   the Resend key (sends as contato@tucano.sh)
//   npx wrangler secret put LEADS_TO         who gets the emails
//   npx wrangler secret put PHONE_HOOK       the IRM integration's URL
// A failure here only gets logged: whatever triggered it is already saved or already happened.

export async function email(env, { subject, text, replyTo }) {
  if (!env.RESEND_API_KEY || !env.LEADS_TO) return false
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'Tucano <contato@tucano.sh>', to: [env.LEADS_TO], ...(replyTo ? { reply_to: replyTo } : {}), subject, text }),
    })
    if (!r.ok) console.error('email:', r.status, (await r.text()).slice(0, 200))
    return r.ok
  } catch (e) {
    console.error('email:', e instanceof Error ? e.message : e)
    return false
  }
}

// One alert per thing (uid), so the same thing twice is one notification.
export async function phone(env, { uid, title, message }) {
  if (!env.PHONE_HOOK) return false
  try {
    const r = await fetch(env.PHONE_HOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alert_uid: uid, title, message, state: 'alerting' }),
    })
    if (!r.ok) console.error('phone:', r.status, (await r.text()).slice(0, 200))
    return r.ok
  } catch (e) {
    console.error('phone:', e instanceof Error ? e.message : e)
    return false
  }
}

export async function tell(env, note) {
  await Promise.all([email(env, note), phone(env, { uid: note.uid, title: note.subject, message: note.text })])
}

// The three extensions an agent's browser can carry, one row each (Settings › Agents › Anúncios e avisos
// de cookies). Each row is its own switch: on downloads it and puts it in the next session's browser, off
// takes its folder off the disk. The catalogue of the three lives in shared/addons.ts, which the core also
// installs from, so a name cannot drift from what is on disk.
import type { ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ADD_ONS, addOnOn, addOnsOf } from '../../../shared/addons'
import type { AddOn } from '../../../shared/types'
import { useStore, updateSettings } from '../store'
import { Icon, Toggle, type IconName } from './ui'

// What each one promises to fix, in one line, and the glyph that stands for it. The store's own logo would
// be a second download for a picture, and it is not there before the extension is.
const LOOK: Record<AddOn, { icon: IconName; fixes: () => string }> = {
  ads: { icon: 'shield', fixes: () => L('Tira os anúncios da página: o que sobra é a página.', 'Takes the ads off the page: what is left is the page itself.') },
  cookies: { icon: 'hide', fixes: () => L('Fecha o aviso de cookies sozinho, e o banner sai da frente do artigo.', 'Closes the cookie notice by itself, and the banner leaves the article alone.') },
  consent: { icon: 'ask', fixes: () => L('Responde o diálogo de consentimento, inclusive as listas de “interesse legítimo”.', 'Answers the consent dialog, including the “legitimate interest” lists.') }
}

export function AgentAddOns(): ReactNode {
  const stored = useStore((s) => s.settings.browserAddOns)
  const info = useStore((s) => s.settings.addOns)
  const browser = info?.browser
  return (
    <>
      {/* Chrome for Testing, which the three share: the one download that is not any of their switches. */}
      {browser?.state === 'preparing' && (
        <p className="muted small">
          {L('Baixando o Chrome for Testing', 'Downloading Chrome for Testing')}
          {browser.progress?.total ? ` · ${Math.min(99, Math.round((browser.progress.received / browser.progress.total) * 100))}%` : '…'}{' '}
          {L('— o navegador continua como está até terminar.', '— the browser works as it is until it lands.')}
        </p>
      )}
      {browser?.state === 'failed' && (
        <p className="field__error">
          {L('O Chrome for Testing não baixou: ', 'Chrome for Testing didn’t download: ')}
          {browser.error ?? ''}
        </p>
      )}
      {ADD_ONS.map((extension) => {
        const look = LOOK[extension.key]
        const step = info?.extensions[extension.key]
        return (
          <div className="key-row" key={extension.key}>
            <Icon name={look.icon} />
            <div className="grow">
              <strong>{extension.name}</strong>
              <p className="muted small">{look.fixes()}</p>
              {step?.state === 'preparing' && <p className="muted small">{L('Baixando — entra no navegador da próxima sessão.', 'Downloading — it joins the next session’s browser.')}</p>}
              {step?.state === 'failed' && (
                <p className="field__error">
                  {L('Não baixou: ', 'It didn’t download: ')}
                  {step.error ?? ''}
                </p>
              )}
            </div>
            <Toggle
              on={addOnOn(stored, extension.key)}
              onChange={(v) => updateSettings({ browserAddOns: { ...addOnsOf(stored), [extension.key]: v } })}
            />
          </div>
        )
      })}
    </>
  )
}

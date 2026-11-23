// The six extensions an agent's browser can carry, one row each (Settings › Agents › Extensões do
// navegador), and under them one switch for how that browser behaves. Each row is its own switch: on
// downloads it, sets it up for an agent and puts it in the next session's browser; off takes its folder
// off the disk. The catalogue of the five lives in shared/addons.ts, which the core also installs from,
// so a name cannot drift from what is on disk.
import type { ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ADD_ONS, addOnOn, addOnsOf } from '../../../shared/addons'
import type { AddOn } from '../../../shared/types'
import { useStore, updateSettings } from '../store'
import { Icon, Toggle, type IconName } from './ui'

// What each one promises to fix, in one line, and the glyph that stands for it. The store's own logo would
// be a second download for a picture, and it is not there before the extension is.
const LOOK: Record<AddOn, { icon: IconName; fixes: () => string }> = {
  ads: { icon: 'shield', fixes: () => L('Tira os anúncios da página, e o espaço que eles deixavam.', 'Takes the ads off the page, and the space they left behind.') },
  cookies: { icon: 'hide', fixes: () => L('Fecha o aviso de cookies sozinho, e o banner sai da frente do artigo.', 'Closes the cookie notice by itself, and the banner leaves the article alone.') },
  consent: { icon: 'ask', fixes: () => L('Responde o diálogo de consentimento, inclusive as listas de “interesse legítimo”.', 'Answers the consent dialog, including the “legitimate interest” lists.') },
  popups: { icon: 'layers', fixes: () => L('Tira da frente o que fica por cima da página: barras fixas, gavetas, pop-ups.', 'Clears what sits on top of the page: sticky bars, drawers, pop-ups.') },
  clutter: { icon: 'book', fixes: () => L('Deixa a página só com o que se lê. Muda o desenho da página: o print deixa de ser o do site.', 'Leaves the page as what is readable. It changes how the page looks: a screenshot stops being the site’s.') },
  defuddle: { icon: 'file-text', fixes: () => L('Extrai o artigo da página como texto limpo, sem menus, anúncios ou rodapés. O agente lê o que importa.', 'Pulls the article out of the page as clean text, no menus, ads or footers. The agent reads what matters.') }
}

export function AgentAddOns(): ReactNode {
  const stored = useStore((s) => s.settings.browserAddOns)
  const info = useStore((s) => s.settings.addOns)
  const accessible = useStore((s) => !!s.settings.browserAccessibility)
  const browser = info?.browser
  return (
    <>
      {/* Chrome for Testing, which the five share: the one download that is not any of their switches. */}
      {browser?.state === 'preparing' && (
        <p className="muted small">
          {L('Baixando o Chrome for Testing', 'Downloading Chrome for Testing')}
          {browser.progress?.total ? ` · ${Math.min(99, Math.round((browser.progress.received / browser.progress.total) * 100))}%` : '…'}{' '}
          {L('— o navegador continua como está até terminar.', '— the browser works as it is until it lands.')}
        </p>
      )}
      {browser?.state === 'failed' && (
        <p className="field__error">
          {L('O Chrome for Testing não está disponível: ', 'Chrome for Testing isn’t available: ')}
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
              {/* Its own vendor's default rather than the one an agent needs: said plainly, under its row. */}
              {step?.note && <p className="muted small">{step.note}</p>}
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
      {/* Not an extension: two of Chrome's own switches, which is why it is one row and one word. */}
      <div className="key-row">
        <Icon name="eye" />
        <div className="grow">
          <strong>{L('Acessibilidade extra', 'Additional accessibility')}</strong>
          <p className="muted small">
            {L(
              'A página pede menos animação — o botão não sai de baixo do clique — e nenhum vídeo começa sozinho.',
              'Pages ask for less motion — the button stays where the click goes — and no video starts on its own.'
            )}
          </p>
        </div>
        <Toggle on={accessible} onChange={(v) => updateSettings({ browserAccessibility: v })} />
      </div>
    </>
  )
}

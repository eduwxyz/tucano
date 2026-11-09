// UI smoke test on a disposable workspace with fake engines; never uses live agents.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const data = mkdtempSync(join(tmpdir(), 'tucano-model-panel-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1', TUCANO_LOCALE: 'pt-BR' } })
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.setViewportSize({ width: 1360, height: 1000 })
  await win.locator('.sidebar').waitFor()
  const open = async () => {
    await win.getByRole('button', { name: 'Configurações', exact: true }).click()
    await win.getByRole('tab', { name: 'Modelos', exact: true }).click()
    await win.locator('.agent-models').waitFor()
  }
  await open()
  const panel = win.locator('.agent-models')
  const rows = panel.locator('.agent-models__row')
  assert.ok(await rows.count() >= 3)
  const lia = panel.getByRole('group', { name: 'Lia', exact: true })
  await lia.locator('.model-picker [role="combobox"]').last().click()
  await win.getByRole('option', { name: /^Opus/ }).first().click()
  await lia.getByRole('button', { name: 'Salvar', exact: true }).click()
  await win.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('Modelo atualizado'))
  assert.match(await lia.innerText(), /Em uso:.*Opus/)
  const bulk = panel.locator('.agent-models__bulk')
  await bulk.locator('[role="combobox"]').first().click()
  await win.getByRole('option', { name: 'Claude Code', exact: true }).click()
  await bulk.locator('[role="combobox"]').last().click()
  await win.getByRole('option', { name: /^Haiku/ }).first().click()
  await panel.getByLabel('Selecionar todos os exibidos').check()
  const count = await rows.count()
  await bulk.getByRole('button', { name: /Aplicar aos selecionados/ }).click()
  await win.waitForFunction((n) => document.querySelector('[role="status"]')?.textContent.includes(`em ${n} agente`), count)
  await win.reload()
  await win.locator('.sidebar').waitFor()
  await open()
  for (const row of await rows.all()) assert.match(await row.innerText(), /Em uso:.*Haiku/)
  await panel.screenshot({ path: join(data, 'agent-models-panel.png') })
  await win.screenshot({ path: join(data, 'painel-modelos.png') })
  await win.setViewportSize({ width: 800, height: 900 })
  await win.screenshot({ path: join(data, 'painel-modelos-compacto.png') })
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ ok: true, agents: count, data, screenshot: join(data, 'painel-modelos.png'), checks: ['individual save', 'bulk save', 'persistence after reload', 'no renderer errors'] }))
} finally {
  await app.close()
}

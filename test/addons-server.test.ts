// On a server the browser extensions don't exist yet: not until they are tested in its container.
import { beforeAll, describe, expect, it } from 'vitest'
import type { Snapshot } from '../src/shared/rpc'
import type { Settings } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

describe('browser extensions on a server', () => {
  let owner: Client

  beforeAll(async () => {
    const core = await bootCore({ server: true })
    owner = core.connect()
  })

  it('tells the page there are none', async () => {
    expect((await owner.call<Snapshot>('snapshot')).browserExtensions).toBe(false)
  })

  it('ignores a switch sent to it, valid or not, and keeps the other settings of the same patch', async () => {
    await owner.call('updateSettings', { patch: { browserAddOns: { ads: true, cookies: true, consent: true, popups: true, clutter: true }, browserAccessibility: true, context: 'kept' } })
    await owner.call('updateSettings', { patch: { browserAddOns: 'not even a setting' } })
    const { settings } = await owner.call<Snapshot>('snapshot')
    expect((settings as Settings).browserAddOns).toBeUndefined()
    expect((settings as Settings).browserAccessibility).toBeUndefined()
    expect((settings as Settings).addOns).toBeUndefined()
    expect((settings as Settings).context).toBe('kept')
  })
})

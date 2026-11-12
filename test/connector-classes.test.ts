// A tool's class follows the rules while it's automatic, and stays as the person set it once they
// chose one by hand: on a refresh, and on the first sync after an upgrade that changed the rules
// (sends and posts became sensitive), when the database doesn't yet know which classes were automatic.
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { classify, legacyClassify } from '../src/core/policy'

const schema = { type: 'object', properties: {} }
const listed = (names: string[]) => names.map((name) => ({ name, description: name, inputSchema: schema, cls: classify({ name }), legacyCls: legacyClassify({ name }) }))
const cls = (db: Db, name: string) => db.tools('s').find((t) => t.name === name)?.cls

describe("a tool's class across syncs", () => {
  it('upgrading: an automatic class takes the new rules; one set by hand stays', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tucano-classes-')), 'tucano.db')
    let db = new Db(file)
    db.saveConnector({ id: 's', name: 'Slack', kind: 'remote', url: 'https://mcp.slack.com/mcp', auth: 'oauth' })
    db.syncTools('s', listed(['chat_post_message', 'reply_to_thread', 'share_file', 'list_messages']))
    db.close()
    // As 0.2.15 left it: the old classes, one changed by hand (share_file to read), none marked automatic.
    const raw = new DatabaseSync(file)
    raw.exec("UPDATE connector_tools SET cls = 'write', cls_auto = NULL; UPDATE connector_tools SET cls = 'read' WHERE name IN ('share_file', 'list_messages')")
    raw.close()

    db = new Db(file)
    db.syncTools('s', listed(['chat_post_message', 'reply_to_thread', 'share_file', 'list_messages']))
    expect(cls(db, 'chat_post_message')).toBe('sensitive') // was automatic ("write" by the old rules)
    expect(cls(db, 'reply_to_thread')).toBe('sensitive')
    expect(cls(db, 'share_file')).toBe('read') // the person's choice: the old rules said "write"
    expect(cls(db, 'list_messages')).toBe('read')
    db.close()
  })

  it('refreshing: a class chosen by hand stays, and going back to the automatic one follows the rules again', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-classes-')), 'tucano.db'))
    db.saveConnector({ id: 's', name: 'Slack', kind: 'remote', url: 'https://mcp.slack.com/mcp', auth: 'oauth' })
    db.syncTools('s', listed(['chat_post_message', 'create_task']))
    db.updateTool('s', 'chat_post_message', { cls: 'write' })
    db.syncTools('s', listed(['chat_post_message', 'create_task']))
    expect(cls(db, 'chat_post_message')).toBe('write')
    expect(cls(db, 'create_task')).toBe('write')
    db.updateTool('s', 'chat_post_message', { cls: 'sensitive' }) // back to what the rules say
    db.syncTools('s', [{ name: 'chat_post_message', description: '', inputSchema: schema, cls: 'write' }, ...listed(['create_task'])]) // the rules change (an annotation, say)
    expect(cls(db, 'chat_post_message')).toBe('write')
    db.close()
  })
})

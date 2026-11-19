import { describe, expect, it } from 'vitest'
import { allowed, approvalHash, canonical, classify, legacyClassify } from '../src/core/policy'
import type { ConnectorTool } from '../src/shared/types'

describe('classify', () => {
  it('trusts annotations first', () => {
    expect(classify({ name: 'delete_everything', annotations: { readOnlyHint: true } })).toBe('read')
    expect(classify({ name: 'list_things', annotations: { destructiveHint: true } })).toBe('sensitive')
  })

  it('reads the name in snake_case and camelCase', () => {
    expect(classify({ name: 'list_issues' })).toBe('read')
    expect(classify({ name: 'getPullRequest' })).toBe('read')
    expect(classify({ name: 'search_code' })).toBe('read')
    expect(classify({ name: 'merge_pull_request' })).toBe('sensitive')
    expect(classify({ name: 'deployService' })).toBe('sensitive')
    expect(classify({ name: 'send_email' })).toBe('sensitive')
    expect(classify({ name: 'create_issue' })).toBe('write')
    expect(classify({ name: 'update_issue' })).toBe('write')
  })

  it('prefers sensitive when a name mixes a read verb with a sensitive word', () => {
    expect(classify({ name: 'get_and_delete_cache' })).toBe('sensitive')
  })

  it("makes every tool that runs another action sensitive, whatever its annotations say", () => {
    // Composio's executors stand in front of every app's real actions: a call can read or send.
    for (const name of ['COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_PROXY_EXECUTE', 'COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL']) {
      expect(classify({ name }), name).toBe('sensitive')
      expect(classify({ name, annotations: { readOnlyHint: true } }), name).toBe('sensitive')
    }
    // Finding a tool and reading its schema only read; connecting an account goes by its annotations.
    expect(classify({ name: 'COMPOSIO_SEARCH_TOOLS', annotations: { readOnlyHint: true } })).toBe('read')
    expect(classify({ name: 'COMPOSIO_GET_TOOL_SCHEMAS', annotations: { readOnlyHint: true } })).toBe('read')
    expect(classify({ name: 'COMPOSIO_MANAGE_CONNECTIONS', annotations: { destructiveHint: true } })).toBe('sensitive')
    // Its direct tools, app first in the name: sending is sensitive; anything else is at least a write.
    expect(classify({ name: 'GMAIL_SEND_EMAIL' })).toBe('sensitive')
    expect(classify({ name: 'GMAIL_FETCH_EMAILS' })).toBe('write')
    expect(classify({ name: 'GMAIL_FETCH_EMAILS', annotations: { readOnlyHint: true } })).toBe('read')
  })

  it('makes sending something to other people sensitive, as the verb only', () => {
    for (const name of ['post_message', 'chat_post_message', 'reply_to_thread', 'forward_email', 'share_file', 'share_issue', 'invite_user', 'comment_on_issue', 'message_create', 'resend_invite'])
      expect(classify({ name }), name).toBe('sensitive')
    // Making a comment, a reply or a post sends it; a draft, a label or an issue doesn't.
    for (const name of ['create_comment', 'add_issue_comment', 'save_comment', 'notion-create-comment', 'add_comment_to_pending_review', 'createReply'])
      expect(classify({ name }), name).toBe('sensitive')
    for (const name of ['create_email_draft', 'create_draft_reply', 'draft_reply', 'add_label_to_email', 'create_issue', 'save_issue', 'update_message', 'unshare_issue'])
      expect(classify({ name }), name).toBe('write')
    // The same words as nouns: still reads.
    for (const name of ['list_messages', 'get_message', 'search_emails', 'list_comments', 'get_issue_comments', 'get_share_link', 'fetch_posts'])
      expect(classify({ name }), name).toBe('read')
    expect(classify({ name: 'email_search' })).toBe('write') // a search after it: a noun, not a send
    expect(classify({ name: 'post_message', annotations: { readOnlyHint: true } })).toBe('read') // annotations still first
    // What it was before: only these changed.
    expect(legacyClassify({ name: 'post_message' })).toBe('write')
    expect(legacyClassify({ name: 'send_email' })).toBe('sensitive')
  })

  it('does not match words inside other words', () => {
    expect(classify({ name: 'list_payments' })).toBe('read') // "pay" is not "payments"
    expect(classify({ name: 'resend_code' })).toBe('write') // "send" is not "resend"
  })
})

describe('allowed', () => {
  const tool = (cls: ConnectorTool['cls'], enabled = true): ConnectorTool => ({ name: 't', description: '', cls, enabled, highRisk: false, isNew: false })

  it('read grants only read tools; read_write grants all; none and missing grant nothing', () => {
    expect(allowed(tool('read'), 'read')).toBe(true)
    expect(allowed(tool('write'), 'read')).toBe(false)
    expect(allowed(tool('sensitive'), 'read')).toBe(false)
    expect(allowed(tool('sensitive'), 'read_write')).toBe(true)
    expect(allowed(tool('read'), 'none')).toBe(false)
    expect(allowed(tool('read'), undefined)).toBe(false)
  })

  it('never allows a disabled tool', () => {
    expect(allowed(tool('read', false), 'read_write')).toBe(false)
  })
})

describe('approval binding', () => {
  it('canonical JSON ignores key order, keeps array order and drops undefined', () => {
    expect(canonical({ b: 1, a: { d: [2, 1], c: 'x' }, z: undefined })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}')
  })

  it('the same call hashes the same; any change gives another hash', () => {
    const h = approvalHash('github', 'merge_pull_request', { repo: 'acme/checkout', pull_number: 213 })
    expect(approvalHash('github', 'merge_pull_request', { pull_number: 213, repo: 'acme/checkout' })).toBe(h)
    expect(approvalHash('github', 'merge_pull_request', { repo: 'acme/checkout', pull_number: 214 })).not.toBe(h)
    expect(approvalHash('github', 'merge_pull_request', { repo: 'acme/checkout', pull_number: '213' })).not.toBe(h)
    expect(approvalHash('gitlab', 'merge_pull_request', { repo: 'acme/checkout', pull_number: 213 })).not.toBe(h)
  })
})

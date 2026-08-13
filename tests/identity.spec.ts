import { describe, expect, it } from 'vitest'
import { freshSessionId, latestSession, originKey, sessionPrefix, sessionsForPrefix } from '../src/identity.js'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'

describe('session identity', () => {
  it('isolates group senders by default and can share at chat scope', () => {
    const message = { chatType: 'group' as const, chatId: 'oc_team', senderId: 'ou_alice', messageId: 'om_root' }
    expect(originKey(message, 'sender')).toBe('group:oc_team:ou_alice')
    expect(originKey(message, 'chat')).toBe('group:oc_team')
  })

  it('maps a topic root and every reply to one project-scoped Session', () => {
    const root = {
      chatType: 'group' as const,
      chatId: 'oc_project',
      senderId: 'ou_alice',
      messageId: 'om_root',
    }
    const reply = {
      ...root,
      senderId: 'ou_bob',
      messageId: 'om_reply',
      rootId: 'om_root',
    }
    expect(originKey(root, 'thread', 'ios')).toBe('project:ios:group:oc_project:thread:om_root')
    expect(originKey(reply, 'thread', 'ios')).toBe(originKey(root, 'thread', 'ios'))
    expect(originKey(root, 'thread', 'mac')).not.toBe(originKey(root, 'thread', 'ios'))
  })

  it('uses a stable opaque prefix and sortable fresh ids', () => {
    const prefix = sessionPrefix('p2p:oc_private')
    expect(prefix).toMatch(/^lark-[a-f0-9]{24}$/u)
    expect(String(freshSessionId(prefix, 1_000))).toBe(`${prefix}-${(1_000).toString(36)}`)
  })

  it('selects and lists the newest persisted session for one origin', () => {
    const prefix = sessionPrefix('p2p:oc_private')
    const headers: SessionHeader[] = [
      { version: 0, id: SessionId(`${prefix}-a`), createdAt: 10 },
      { version: 0, id: SessionId('other-a'), createdAt: 99 },
      { version: 0, id: SessionId(`${prefix}-b`), createdAt: 20 },
    ]
    expect(latestSession(headers, prefix)?.id).toBe(`${prefix}-b`)
    expect(sessionsForPrefix(headers, prefix).map(item => item.id)).toEqual([`${prefix}-b`, `${prefix}-a`])
  })
})

import { createHash } from 'node:crypto'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { GroupSessionScope } from './types.js'

export function originKey(
  message: Pick<NormalizedMessage, 'chatType' | 'chatId' | 'senderId' | 'messageId' | 'rootId'>,
  groupScope: GroupSessionScope,
  projectId?: string,
): string {
  const project = projectId === undefined ? '' : `project:${projectId}:`
  if (message.chatType === 'p2p' || groupScope === 'chat') return `${project}${message.chatType}:${message.chatId}`
  if (groupScope === 'thread') {
    return `${project}group:${message.chatId}:thread:${message.rootId ?? message.messageId}`
  }
  return `${project}group:${message.chatId}:${message.senderId}`
}

export function sessionPrefix(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return `lark-${digest}`
}

export function freshSessionId(prefix: string, now = Date.now()): SessionId {
  return brandSessionId(`${prefix}-${now.toString(36)}`)
}

export function latestSession(headers: readonly SessionHeader[], prefix: string): SessionHeader | undefined {
  return headers
    .filter(header => String(header.id).startsWith(`${prefix}-`))
    .toSorted((left, right) => right.createdAt - left.createdAt)[0]
}

export function sessionsForPrefix(headers: readonly SessionHeader[], prefix: string): SessionHeader[] {
  return headers
    .filter(header => String(header.id).startsWith(`${prefix}-`))
    .toSorted((left, right) => right.createdAt - left.createdAt)
}

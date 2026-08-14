import { describe, expect, it } from 'vitest'
import {
  buildApprovalCard,
  buildQuestionCard,
  buildSetupCard,
  buildTurnCard,
  parseBridgeAction,
} from '../src/cards.js'

function allObjects(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return []
  if (Array.isArray(value)) return value.flatMap(allObjects)
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(allObjects)]
}

describe('Feishu card builders', () => {
  it('uses JSON 2.0 callback behaviors for approval buttons', () => {
    const card = buildApprovalCard({ token: 't1', toolName: 'bash', sessionId: 's1' }) as Record<string, unknown>
    expect(card.schema).toBe('2.0')
    const buttons = allObjects(card).filter(item => item.tag === 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons.every(item => Array.isArray(item.behaviors))).toBe(true)
    expect(JSON.stringify(card)).toContain('"decision":"allow"')
  })

  it('redacts sensitive values from progress cards', () => {
    const card = buildTurnCard({
      progress: {
        turn: 1,
        startedAt: 1,
        prompt: 'use sk-1234567890abcdef',
        visibleText: 'Authorization: Bearer abcdefghijk',
        tools: [{ callId: 'c1', name: 'bash', summary: 'api_key=verysecret', startedAt: 1 }],
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        terminal: false,
      },
      sessionId: 's1',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      project: 'Demo',
      preset: 'developer',
      now: 2_001,
      maxBodyChars: 12_000,
    })
    const json = JSON.stringify(card)
    expect(json).not.toContain('sk-1234567890abcdef')
    expect(json).not.toContain('abcdefghijk')
    expect(json).not.toContain('verysecret')
    expect(json).toContain('[REDACTED]')
  })

  it('offers compact, standard, and developer information densities', () => {
    const progress = {
      turn: 1,
      startedAt: 1,
      prompt: '检查项目',
      visibleText: '检查完成。',
      tools: [{ callId: 'c1', name: 'bash', summary: 'command: pnpm test', startedAt: 1, finishedAt: 2 }],
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      terminal: true,
    }
    const render = (preset: 'compact' | 'standard' | 'developer') => {
      const card = buildTurnCard({
      progress,
      sessionId: 'session-secret-shape',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      project: 'Demo',
      preset,
      now: 2_001,
      outcome: 'completed',
      maxBodyChars: 12_000,
      })
      return allObjects(card)
        .map(item => item.content)
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
    }
    const compact = render('compact')
    const standard = render('standard')
    const developer = render('developer')
    expect(compact).not.toContain('session-secret-shape')
    expect(compact).not.toContain('deepseek-v4-flash')
    expect(compact).not.toContain('执行轨迹')
    expect(standard).toContain('deepseek-v4-flash')
    expect(standard).toContain('执行轨迹')
    expect(standard).not.toContain('command: pnpm test')
    expect(developer).toContain('session-secret-shape')
    expect(developer).toContain('command: pnpm test')
    expect(developer).toContain('缓存 token')
  })

  it('does not repeat the replied-to task inside progress cards', () => {
    const prompt = '这段原始任务只应出现在飞书的引用回复中'
    const card = buildTurnCard({
      progress: {
        turn: 1,
        startedAt: 1,
        prompt,
        visibleText: '任务完成。',
        tools: [],
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        terminal: true,
      },
      sessionId: 's1',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      project: 'Demo',
      preset: 'developer',
      now: 2_001,
      outcome: 'completed',
      maxBodyChars: 12_000,
    })
    const json = JSON.stringify(card)
    expect(json).not.toContain('**任务**')
    expect(json).not.toContain(prompt)
    expect(json).toContain('任务完成。')
  })

  it('renders multi-select questions with explicit submit control', () => {
    const card = buildQuestionCard({
      token: 'q1',
      question: {
        id: 'choice',
        question: '选择能力',
        options: [{ label: '图片' }, { label: '文件' }],
        multiSelect: true,
      },
      selected: new Set([0]),
    })
    const json = JSON.stringify(card)
    expect(json).toContain('✓ 图片')
    expect(json).toContain('question-submit')
  })

  it('strictly parses only bridge-owned action payloads', () => {
    expect(parseBridgeAction({ bridge: 'other', action: 'stop', sessionId: 's' })).toBeUndefined()
    expect(parseBridgeAction({ bridge: 'dsh-lark-bridge', action: 'stop', sessionId: 's' })).toEqual({
      bridge: 'dsh-lark-bridge', action: 'stop', sessionId: 's',
    })
    expect(parseBridgeAction({ bridge: 'dsh-lark-bridge', action: 'approval', token: 't', decision: 'always' })).toBeUndefined()
    expect(parseBridgeAction({ bridge: 'dsh-lark-bridge', action: 'question-option', token: 't', index: 0 })).toEqual({
      bridge: 'dsh-lark-bridge', action: 'question-option', token: 't', index: 0,
    })
    expect(parseBridgeAction({ bridge: 'dsh-lark-bridge', action: 'question-option', token: 't', index: -1 })).toBeUndefined()
    expect(parseBridgeAction({ bridge: 'dsh-lark-bridge', action: 'view', sessionId: 's' })).toEqual({
      bridge: 'dsh-lark-bridge', action: 'view', sessionId: 's',
    })
    expect(parseBridgeAction({ bridge: 'dsh-lark-bridge', action: 'setup-verify' })).toEqual({
      bridge: 'dsh-lark-bridge', action: 'setup-verify',
    })
  })

  it('renders a one-click setup callback check', () => {
    const pending = JSON.stringify(buildSetupCard({ project: 'Demo' }))
    expect(pending).toContain('测试卡片按钮（可选）')
    expect(pending).toContain('现在就能直接发送任务')
    expect(pending).toContain('setup-verify')
    const verified = JSON.stringify(buildSetupCard({ project: 'Demo', verified: true }))
    expect(verified).toContain('全部就绪')
    expect(verified).not.toContain('setup-verify')
  })

  it('keeps every interactive element id unique across multi-row questions', () => {
    const card = buildQuestionCard({
      token: 'q2',
      question: {
        id: 'many',
        question: '选择能力',
        options: ['文本', '图片', '文件', '审批'].map(label => ({ label })),
        multiSelect: true,
      },
    })
    const ids = allObjects(card)
      .map(item => item.element_id)
      .filter((value): value is string => typeof value === 'string')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('redacts question text, labels, and callback payloads', () => {
    const json = JSON.stringify(buildQuestionCard({
      token: 'q3',
      question: {
        id: 'secret',
        question: '密钥 sk-1234567890abcdef',
        options: [{ label: 'token=verysecret' }],
        multiSelect: false,
      },
    }))
    expect(json).not.toContain('sk-1234567890abcdef')
    expect(json).not.toContain('verysecret')
    expect(json).toContain('[REDACTED]')
    expect(json).toContain('"index":0')
  })
})

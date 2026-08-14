import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { BridgeAction, CardPreset, ToolProgress, TurnProgress } from './types.js'
import { bounded, redactSecrets } from './security.js'

type CardTemplate = 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'purple'
type ButtonType = 'default' | 'primary' | 'danger'

interface ButtonSpec {
  label: string
  type?: ButtonType
  value: BridgeAction
}

function button(spec: ButtonSpec, index: number, rowId: string): object {
  return {
    tag: 'button',
    element_id: `${rowId}_btn_${index}`,
    text: { tag: 'plain_text', content: spec.label },
    type: spec.type ?? 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: spec.value }],
  }
}

function buttonRow(buttons: ButtonSpec[], rowId: string): object {
  return {
    tag: 'column_set',
    element_id: rowId,
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: buttons.map((spec, index) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [button(spec, index, rowId)],
    })),
  }
}

function markdown(content: string, elementId?: string): object {
  return {
    tag: 'markdown',
    ...(elementId === undefined ? {} : { element_id: elementId }),
    content,
  }
}

function card(title: string, template: CardTemplate, elements: object[], summary = title): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: bounded(summary.replace(/\s+/g, ' ').trim(), 80) },
    },
    header: {
      title: { tag: 'plain_text', content: bounded(title, 80) },
      template,
      padding: '12px 12px 12px 12px',
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements,
    },
  }
}

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m${String(remainder).padStart(2, '0')}s`
}

function compactPath(path: string): string {
  const home = process.env.HOME
  return home !== undefined && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function toolLine(tool: ToolProgress, now: number): string {
  const icon = tool.finishedAt === undefined ? '⏳' : tool.failed ? '❌' : '✅'
  const duration = elapsed(tool.startedAt, tool.finishedAt ?? now)
  const summary = tool.summary === '' ? '' : ` · ${bounded(redactSecrets(tool.summary), 140)}`
  return `${icon} \`${tool.name}\`${summary} _${duration}_`
}

export interface TurnCardInput {
  progress: TurnProgress
  sessionId: string
  cwd: string
  model: string
  project: string
  preset: CardPreset
  now?: number
  outcome?: 'completed' | 'cancelled' | 'blocked' | 'error'
  outcomeDetail?: string
  maxBodyChars: number
}

/** Build the single mutable card used from turn start through terminal outcome. */
export function buildTurnCard(input: TurnCardInput): object {
  const now = input.now ?? Date.now()
  const done = input.outcome !== undefined
  const titleByOutcome = {
    completed: '✅ DeepSeek Harness 已完成',
    cancelled: '⏹️ DeepSeek Harness 已停止',
    blocked: '⚠️ DeepSeek Harness 等待处理',
    error: '❌ DeepSeek Harness 执行失败',
  } as const
  const templateByOutcome = {
    completed: 'green',
    cancelled: 'grey',
    blocked: 'orange',
    error: 'red',
  } as const
  const title = done ? titleByOutcome[input.outcome!] : `⏳ DeepSeek Harness · ${elapsed(input.progress.startedAt, now)}`
  const template: CardTemplate = done ? templateByOutcome[input.outcome!] : 'blue'
  const elements: object[] = []

  if (input.preset === 'developer') {
    elements.push(markdown(`📦 ${input.project}  ·  📁 ${compactPath(input.cwd)}  ·  🤖 ${input.model}  ·  🧵 \`${input.sessionId}\``))
  } else if (input.preset === 'standard') {
    elements.push(markdown(`📦 ${input.project}  ·  🤖 ${input.model}`))
  }

  const toolLimit = input.preset === 'developer' ? 12 : input.preset === 'standard' ? 6 : 0
  const visibleTools = toolLimit === 0 ? [] : input.progress.tools.slice(-toolLimit)
  if (visibleTools.length > 0) {
    const hidden = input.progress.tools.length - visibleTools.length
    const prefix = hidden > 0 ? `_前 ${hidden} 个工具调用已折叠_\n` : ''
    const lines = input.preset === 'developer'
      ? visibleTools.map(tool => toolLine(tool, now))
      : visibleTools.map(tool => {
        const icon = tool.finishedAt === undefined ? '⏳' : tool.failed ? '❌' : '✅'
        return `${icon} \`${tool.name}\``
      })
    elements.push(markdown(`**执行轨迹**\n${prefix}${lines.join('\n')}`))
  }

  const cleanText = redactSecrets(input.progress.visibleText).trim()
  if (cleanText !== '') {
    const body = bounded(cleanText, input.maxBodyChars)
    elements.push(markdown(`**${done ? '结果' : '实时输出'}**\n${body}`, 'bridge_output'))
  }

  const stats = [`⏱️ ${elapsed(input.progress.startedAt, now)}`]
  if (input.preset !== 'compact') stats.push(`🔧 ${input.progress.tools.length} 次工具调用`)
  if (input.preset === 'developer') {
    stats.push(`⬇️ ${input.progress.inputTokens} 输入 token`, `⬆️ ${input.progress.outputTokens} 输出 token`)
    if (input.progress.cacheReadTokens > 0) stats.push(`💾 ${input.progress.cacheReadTokens} 缓存 token`)
  } else if (input.preset === 'standard' && input.progress.inputTokens + input.progress.outputTokens > 0) {
    stats.push(`🪙 ${input.progress.inputTokens + input.progress.outputTokens} token`)
  }
  elements.push(markdown(stats.join('  ·  ')))

  if (input.outcomeDetail !== undefined && input.outcomeDetail.trim() !== '') {
    elements.push(markdown(`_${bounded(redactSecrets(input.outcomeDetail), 700)}_`))
  }

  if (!done) {
    elements.push(buttonRow([{
      label: '停止任务',
      type: 'danger',
      value: { bridge: 'dsh-lark-bridge', action: 'stop', sessionId: input.sessionId },
    }], 'bridge_turn_actions'))
  } else {
    elements.push(buttonRow([
      {
        label: '新会话',
        type: 'primary',
        value: { bridge: 'dsh-lark-bridge', action: 'new', sessionId: input.sessionId },
      },
      {
        label: '查看状态',
        value: { bridge: 'dsh-lark-bridge', action: 'status', sessionId: input.sessionId },
      },
      {
        label: `视图：${{ compact: '精简', standard: '标准', developer: '开发者' }[input.preset]}`,
        value: { bridge: 'dsh-lark-bridge', action: 'view', sessionId: input.sessionId },
      },
    ], 'bridge_turn_actions'))
  }

  return card(title, template, elements, cleanText || title)
}

export interface ApprovalCardInput {
  token: string
  toolName: string
  reason?: string
  sessionId: string
  settled?: 'allowed' | 'rejected' | 'cancelled' | 'unavailable'
}

export function buildApprovalCard(input: ApprovalCardInput): object {
  if (input.settled !== undefined) {
    const labels = {
      allowed: ['✅ 已允许一次', 'green'],
      rejected: ['⛔ 已拒绝', 'red'],
      cancelled: ['⏹️ 请求已取消', 'grey'],
      unavailable: ['⌛ 请求已失效', 'orange'],
    } as const
    const [title, template] = labels[input.settled]
    return card(title, template, [markdown(`工具：\`${input.toolName}\`\n\n会话：\`${input.sessionId}\``)])
  }
  const reason = input.reason?.trim() === '' || input.reason === undefined
    ? '该操作超出当前自动权限，需要你明确确认。'
    : bounded(redactSecrets(input.reason), 1200)
  return card('🔐 DeepSeek Harness 请求授权', 'orange', [
    markdown(`**工具**：\`${input.toolName}\`\n\n**原因**：${reason}\n\n会话：\`${input.sessionId}\``),
    buttonRow([
      {
        label: '仅允许这一次',
        type: 'primary',
        value: { bridge: 'dsh-lark-bridge', action: 'approval', token: input.token, decision: 'allow' },
      },
      {
        label: '拒绝',
        type: 'danger',
        value: { bridge: 'dsh-lark-bridge', action: 'approval', token: input.token, decision: 'reject' },
      },
    ], 'bridge_approval_actions'),
  ])
}

export interface QuestionCardInput {
  token: string
  question: AskUserQuestionItem
  selected?: ReadonlySet<number>
  settled?: string
}

export function buildQuestionCard(input: QuestionCardInput): object {
  const question = input.question
  if (input.settled !== undefined) {
    return card('✅ 已收到回答', 'green', [
      markdown(`**${redactSecrets(question.header ?? '问题')}**\n${bounded(redactSecrets(question.question), 1000)}\n\n回答：${bounded(redactSecrets(input.settled), 1000)}`),
    ])
  }
  const elements: object[] = [
    markdown(`**${redactSecrets(question.header ?? 'DeepSeek Harness 需要你的选择')}**\n${bounded(redactSecrets(question.question), 1200)}`),
  ]
  if (question.detail !== undefined && question.detail.trim() !== '') {
    elements.push(markdown(bounded(redactSecrets(question.detail), 5000)))
  }
  const selected = input.selected ?? new Set<number>()
  const options = question.options ?? []
  for (let offset = 0; offset < options.length; offset += 3) {
    elements.push(buttonRow(options.slice(offset, offset + 3).map((option, relativeIndex) => {
      const index = offset + relativeIndex
      return {
        label: `${selected.has(index) ? '✓ ' : ''}${bounded(redactSecrets(option.label), 40)}`,
        type: selected.has(index) ? 'primary' : 'default',
        value: {
          bridge: 'dsh-lark-bridge',
          action: 'question-option',
          token: input.token,
          index,
        },
      }
    }), `bridge_question_options_${offset / 3}`))
  }
  if (question.multiSelect) {
    elements.push(buttonRow([{
      label: '提交选择',
      type: 'primary',
      value: { bridge: 'dsh-lark-bridge', action: 'question-submit', token: input.token },
    }], 'bridge_question_submit'))
  }
  elements.push(markdown('_也可以直接回复一条消息，作为“其他”答案。_'))
  return card('💬 DeepSeek Harness 正在等待回答', 'purple', elements)
}

export interface StatusCardInput {
  sessionId: string
  status: 'idle' | 'running'
  cwd: string
  provider: string
  model: string
  connected: boolean
  pendingApprovals: number
  pendingQuestions: number
  project: string
  preset: CardPreset
}

export function buildStatusCard(input: StatusCardInput): object {
  const status = input.status === 'running' ? '运行中' : '空闲'
  return card('DeepSeek Harness Lark Bridge', input.status === 'running' ? 'blue' : 'green', [
    markdown([
      `**状态**：${status}`,
      `**飞书长连接**：${input.connected ? '已连接' : '未连接'}`,
      `**项目**：${input.project}`,
      `**会话**：\`${input.sessionId}\``,
      `**目录**：${compactPath(input.cwd)}`,
      `**模型**：${input.provider} / ${input.model}`,
      `**待审批**：${input.pendingApprovals}`,
      `**待回答**：${input.pendingQuestions}`,
      `**卡片视图**：${input.preset}`,
    ].join('\n')),
  ], `${status} · ${input.model}`)
}

/** Build the first-run card; its optional button proves callbacks work. */
export function buildSetupCard(input: { verified?: boolean; project: string }): object {
  const verified = input.verified ?? false
  return card(verified ? '✅ Lark Bridge 全部就绪' : '🎉 Lark Bridge 已就绪', verified ? 'green' : 'blue', [
    markdown([
      '✅ 已接收你的飞书消息',
      '✅ 机器人可以发送消息',
      `${verified ? '✅ 卡片按钮已验证' : '🧪 卡片按钮可选验证'}`,
      `📦 默认 Project：**${bounded(redactSecrets(input.project), 80)}**`,
      '',
      verified
        ? '现在可以直接发送任务；把机器人加入群后，第一次 @它即可自动绑定。'
        : '现在就能直接发送任务。下面的按钮仅用于检查卡片回调，不影响使用。',
    ].join('\n')),
    ...(verified ? [] : [buttonRow([{
      label: '测试卡片按钮（可选）',
      type: 'primary',
      value: { bridge: 'dsh-lark-bridge', action: 'setup-verify' },
    }], 'bridge_setup_verify')]),
  ], verified ? '全部就绪，可以开始使用' : '已就绪，可以直接发送任务')
}

export function parseBridgeAction(value: unknown): BridgeAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const action = value as Record<string, unknown>
  if (action.bridge !== 'dsh-lark-bridge' || typeof action.action !== 'string') return undefined
  switch (action.action) {
    case 'setup-verify':
      return action as BridgeAction
    case 'stop':
    case 'new':
    case 'status':
    case 'view':
      return typeof action.sessionId === 'string' ? action as BridgeAction : undefined
    case 'approval':
      return typeof action.token === 'string' && (action.decision === 'allow' || action.decision === 'reject')
        ? action as BridgeAction
        : undefined
    case 'question-option':
      return typeof action.token === 'string' && Number.isInteger(action.index) && Number(action.index) >= 0
        ? action as BridgeAction
        : undefined
    case 'question-submit':
      return typeof action.token === 'string' ? action as BridgeAction : undefined
    default:
      return undefined
  }
}

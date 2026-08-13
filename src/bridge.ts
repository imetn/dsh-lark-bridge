import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  createLarkChannel,
  LoggerLevel,
  type CardActionEvent,
  type NormalizedMessage,
  type ReactionEvent,
  type ResourceDescriptor,
} from '@larksuiteoapi/node-sdk'
import {
  buildApprovalCard,
  buildQuestionCard,
  buildStatusCard,
  buildTurnCard,
  parseBridgeAction,
} from './cards.js'
import { freshSessionId, latestSession, originKey, sessionPrefix, sessionsForPrefix } from './identity.js'
import {
  bounded,
  boundedUtf8Buffer,
  imageMediaType,
  isOpenIdAllowed,
  isImageFileName,
  readBufferWithLimit,
  redactSecrets,
  resolveOutboundFile,
  saveInboundFile,
} from './security.js'
import type {
  BridgeAction,
  CardPreset,
  ChannelFactory,
  LarkChannelLike,
  ResolvedConfig,
  ResolvedProject,
  TurnProgress,
} from './types.js'

interface RouteContext {
  chatId: string
  chatType: 'p2p' | 'group'
  ownerOpenId: string
  replyTo?: string
  replyInThread: boolean
}

interface BridgeSession {
  readonly key: string
  readonly prefix: string
  readonly route: RouteContext
  readonly project: ResolvedProject
  handle: AgentHandle
  sessionId: string
  cardPreset: CardPreset
  pendingPrompt: string
  progress?: TurnProgress
  progressTimer?: ReturnType<typeof setTimeout>
  outbound: Promise<void>
}

interface PendingApproval {
  token: string
  entry: BridgeSession
  expectedOpenId: string
  toolName: string
  reason?: string
  messageId?: string
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (outcome: ApprovalOutcome) => void
}

interface PendingQuestion {
  token: string
  entry: BridgeSession
  expectedOpenId: string
  question: AskUserQuestionItem
  selected: Set<number>
  messageId?: string
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (answer: AskUserQuestionAnswerItem) => void
  reject: (error: Error) => void
}

const HELP_TEXT = `## DeepSeek Harness Lark Bridge

- 直接发送消息：排入当前 Agent 的下一轮
- \`/steer <内容>\`：在运行中把内容送到最近一步
- \`/status\`：查看连接、模型、目录和会话状态
- \`/stop\`：停止当前任务
- \`/approve\` / \`/reject\`：允许或拒绝当前一次工具审批
- \`/new\`：创建全新会话
- \`/sessions\`：列出当前飞书会话的历史 Session
- \`/resume <session-id>\`：恢复一个历史 Session
- \`/projects\`：列出可用 Project
- \`/project <id>\`：在私聊中切换 Project
- \`/view compact|standard|developer\`：切换当前 Session 的卡片密度
- \`/commands\`：列出 Harness 原生命令
- \`/help\`：显示本说明

飞书卡片按钮可直接处理审批、回答问题、停止任务和新建会话。`

const DEFAULT_CHANNEL_FACTORY: ChannelFactory = config => {
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    source: 'dsh-lark-bridge',
    loggerLevel: LoggerLevel.warn,
    handshakeTimeoutMs: 15_000,
    policy: {
      dmMode: config.allowAllUsers ? 'open' : 'allowlist',
      dmAllowlist: config.allowedOpenIds,
      groupAllowlist: config.allowAllGroups
        ? undefined
        : config.allowedChatIds.length > 0
          ? config.allowedChatIds
          : ['__dsh_lark_bridge_no_groups__'],
      requireMention: config.requireMention,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: true },
      dedup: { ttl: 24 * 60 * 60 * 1000, maxEntries: 20_000 },
      staleMessageWindowMs: 10 * 60 * 1000,
      batch: {
        text: { delayMs: 350, longDelayMs: 80, longThresholdChars: 1800, maxMessages: 8, maxChars: 30_000 },
        media: { delayMs: 400, maxItems: 12 },
      },
    },
    outbound: {
      allowedFileDirs: [...new Set(config.projects.map(project => project.workspaceRoot))],
      ssrfGuard: true,
      retry: { maxAttempts: 3, baseDelayMs: 400 },
      textChunkLimit: 4000,
    },
  })
  return {
    get botIdentity() { return channel.botIdentity },
    connect: () => channel.connect(),
    disconnect: async () => {
      channel.rawWsClient?.close({})
      await channel.disconnect()
    },
    on: (name, handler) => channel.on(name, handler),
    send: (to, input, options) => channel.send(to, input, options),
    updateCard: (messageId, card) => channel.updateCard(messageId, card),
    downloadMessageResource: async (messageId, fileKey, type, maxBytes) => {
      const response = await channel.rawClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })
      return readBufferWithLimit(response.getReadableStream(), maxBytes)
    },
  }
}

function errorMessage(error: unknown): string {
  try {
    return redactSecrets(error instanceof Error ? error.message : String(error))
  } catch {
    return '<无法呈现的错误>'
  }
}

function isCardPreset(value: string): value is CardPreset {
  return value === 'compact' || value === 'standard' || value === 'developer'
}

function nextCardPreset(current: CardPreset): CardPreset {
  if (current === 'compact') return 'standard'
  if (current === 'standard') return 'developer'
  return 'compact'
}

function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  return event.data.message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolSummary(argumentsText: string): string {
  const clean = redactSecrets(argumentsText)
  try {
    const parsed = JSON.parse(clean) as unknown
    if (typeof parsed !== 'object' || parsed === null) return bounded(clean, 180)
    const record = parsed as Record<string, unknown>
    const preferred = ['file_path', 'path', 'command', 'query', 'pattern', 'description', 'url']
    const values = preferred
      .filter(key => typeof record[key] === 'string')
      .map(key => `${key}: ${String(record[key])}`)
    return bounded(values.length > 0 ? values.join(' · ') : JSON.stringify(record), 180)
  } catch {
    return bounded(clean, 180)
  }
}

function terminalOutcome(reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']): {
  outcome: 'completed' | 'cancelled' | 'blocked' | 'error'
  detail?: string
} {
  switch (reason.kind) {
    case 'completed': return { outcome: 'completed' }
    case 'aborted': return { outcome: 'cancelled', detail: `取消来源：${reason.reason.kind}` }
    case 'blocked': return { outcome: 'blocked', detail: 'Agent 未能继续当前轮次。' }
    case 'max-tokens': return { outcome: 'blocked', detail: '模型输出达到 token 上限。' }
    case 'error': return { outcome: 'error', detail: reason.error.message }
    case 'interrupted': return { outcome: 'error', detail: 'Harness 进程中断了该轮次。' }
    default: return { outcome: 'error', detail: `未知结束原因：${String((reason as { kind?: unknown }).kind)}` }
  }
}

function isAuthorizedAction(entry: BridgeSession, openId: string, chatId: string, config: ResolvedConfig): boolean {
  if (entry.route.chatId !== chatId) return false
  const userAllowed = isOpenIdAllowed(
    openId,
    config.allowAllUsers,
    config.allowedOpenIds,
    entry.project.allowedOpenIds,
  )
  if (!userAllowed) return false
  if (entry.route.chatType === 'group' && config.groupSessionScope === 'chat') return true
  return entry.route.ownerOpenId === openId
}

/** Bidirectional adapter between the official Lark Channel API and native Harness agents. */
export class LarkBridge {
  private readonly channel: LarkChannelLike
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly creating = new Map<string, Promise<BridgeSession>>()
  private readonly agents = new Map<string, BridgeSession>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly selectedProjects = new Map<string, string>()
  private headers: SessionHeader[] = []
  private disposers: Array<() => void> = []
  private questionProviderDisposer?: () => void
  private connected = false
  private stopped = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    channelFactory: ChannelFactory = DEFAULT_CHANNEL_FACTORY,
  ) {
    this.channel = channelFactory(config)
  }

  private projectForMessage(message: Pick<NormalizedMessage, 'chatType' | 'chatId' | 'senderId'>): ResolvedProject {
    if (message.chatType === 'group') {
      const bound = this.config.projects.find(project => project.chatIds.includes(message.chatId))
      if (bound !== undefined) {
        if (!this.canUseProject(bound, message.senderId)) throw new Error('you are not allowed to use the project bound to this group')
        return bound
      }
      if (!this.config.allowAllGroups) throw new Error('this group is not bound to a configured Harness project')
    } else {
      const selected = this.selectedProjects.get(message.senderId)
      const project = this.config.projects.find(item => item.id === selected)
      if (project !== undefined && this.canUseProject(project, message.senderId)) return project
    }
    const preferred = this.config.projects.find(project => project.id === this.config.defaultProjectId)
    if (preferred !== undefined && this.canUseProject(preferred, message.senderId)) return preferred
    const fallback = this.config.projects.find(project => this.canUseProject(project, message.senderId))
    if (fallback === undefined) throw new Error('you are not allowed to use any configured Harness project')
    return fallback
  }

  private canUseProject(project: ResolvedProject, openId: string): boolean {
    return project.allowedOpenIds.length === 0 || project.allowedOpenIds.includes(openId)
  }

  private availableProjects(openId: string): ResolvedProject[] {
    return this.config.projects.filter(project => this.canUseProject(project, openId))
  }

  private shouldReplyInThread(message: Pick<NormalizedMessage, 'chatType' | 'threadId' | 'rootId'>): boolean {
    return message.chatType === 'group'
      && (this.config.groupSessionScope === 'thread' || message.threadId !== undefined || message.rootId !== undefined)
  }

  async start(): Promise<void> {
    if (this.connected) return
    this.stopped = false
    const persistence = this.ctx.get('sessionPersistence')
    this.headers = persistence === undefined ? [] : await persistence.list()

    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    }))
    if (this.config.enableApprovals) {
      this.disposers.push(this.ctx.on('approval/request', async (request, next) => {
        const entry = this.agents.get(String(request.agent.id))
        if (entry === undefined) return next()
        return this.askApproval(entry, request)
      }))
    }
    if (this.config.provideUserQuestions) this.registerQuestionProvider()

    this.disposers.push(this.channel.on('message', message => this.onMessage(message)))
    this.disposers.push(this.channel.on('reject', event => {
      this.ctx.logger.warn(
        '[dsh-lark-bridge] 已按策略拒绝飞书消息：reason=%s sender=%s chat=%s message=%s',
        event.reason,
        event.senderId,
        event.chatId,
        event.messageId,
      )
    }))
    this.disposers.push(this.channel.on('cardAction', event => this.onCardAction(event)))
    this.disposers.push(this.channel.on('reaction', event => this.onReaction(event as ReactionEvent)))
    this.disposers.push(this.channel.on('reconnecting', () => {
      this.connected = false
      this.ctx.logger.warn('[dsh-lark-bridge] 飞书长连接正在重连')
    }))
    this.disposers.push(this.channel.on('reconnected', () => {
      this.connected = true
      this.ctx.logger.info('[dsh-lark-bridge] 飞书长连接已恢复')
    }))
    this.disposers.push(this.channel.on('error', error => {
      this.ctx.logger.error('[dsh-lark-bridge] 飞书通道错误：%s', errorMessage(error))
    }))

    try {
      await this.channel.connect()
    } catch (error) {
      await this.stop()
      throw error
    }
    this.connected = true
    this.ctx.logger.info('[dsh-lark-bridge] 已连接飞书机器人 %s', this.channel.botIdentity?.name ?? 'unknown')
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.connected = false
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.questionProviderDisposer?.()
    this.questionProviderDisposer = undefined
    for (const entry of this.sessions.values()) {
      if (entry.progressTimer !== undefined) clearTimeout(entry.progressTimer)
    }
    for (const pending of [...this.pendingApprovals.values()]) this.settleApproval(pending, 'unavailable')
    for (const pending of [...this.pendingQuestions.values()]) {
      this.rejectQuestion(pending, new Error('Lark bridge stopped before the question was answered'))
    }
    await this.channel.disconnect().catch(() => undefined)
    const handles = [...new Set([...this.sessions.values()].map(entry => entry.handle))]
    this.sessions.clear()
    this.agents.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  private registerQuestionProvider(): void {
    const service = this.ctx.get('userQuestions')
    if (service === undefined) return
    try {
      this.questionProviderDisposer = service.registerProvider({
        ask: request => this.askQuestions(request),
      })
    } catch (error) {
      this.ctx.logger.warn('[dsh-lark-bridge] 未接管用户提问：%s', errorMessage(error))
    }
  }

  private async onMessage(message: NormalizedMessage): Promise<void> {
    try {
      const project = this.projectForMessage(message)
      const key = originKey(message, this.config.groupSessionScope, project.id)
      const pending = [...this.pendingQuestions.values()].find(item => (
        item.entry.key === key && item.expectedOpenId === message.senderId
      ))
      const text = message.content.trim()
      if (pending !== undefined && !text.startsWith('/stop')) {
        if (text === '') {
          await this.safeSend(message.chatId, { markdown: '请发送文字回答，或点击卡片中的选项。' }, message)
          return
        }
        this.settleQuestion(pending, { id: pending.question.id, selected: [], custom: text }, text)
        return
      }

      if (text.startsWith('/')) {
        await this.handleCommand(message, text, project)
        return
      }
      if (text === '' && message.resources.length === 0) return

      const entry = await this.ensureSession(message, project)
      entry.route.replyTo = message.messageId
      entry.route.replyInThread = this.shouldReplyInThread(message)
      const content = await this.inboundContent(entry, message)
      entry.pendingPrompt = text === '' ? `[${message.resources.length} 个飞书附件]` : bounded(text, 700)
      entry.handle.agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    } catch (error) {
      this.ctx.logger.error('[dsh-lark-bridge] 消息处理失败：%s', errorMessage(error))
      await this.safeSend(message.chatId, {
        markdown: `❌ 无法把这条消息交给 DeepSeek Harness：${bounded(errorMessage(error), 600)}`,
      }, message)
    }
  }

  private async inboundContent(entry: BridgeSession, message: NormalizedMessage): Promise<ContentBlock[]> {
    const notes: string[] = []
    const images: ContentBlock[] = []
    for (const resource of message.resources) {
      try {
        const data = await this.channel.downloadMessageResource(
          message.messageId,
          resource.fileKey,
          resource.type === 'image' || resource.type === 'sticker' ? 'image' : 'file',
          this.config.maxInboundFileBytes,
        )
        const saved = await saveInboundFile(
          entry.project.inboundDir,
          entry.prefix,
          resource.fileName,
          data,
          this.config.maxInboundFileBytes,
        )
        notes.push(`- ${resource.type}: ${saved.fileName} (${saved.bytes} bytes)\n  本地路径：${saved.absolutePath}`)
        if (this.config.nativeImageInput && (resource.type === 'image' || resource.type === 'sticker')) {
          const attachments = this.ctx.get('attachments')
          const mediaType = imageMediaType(data, saved.fileName)
          if (attachments !== undefined && mediaType !== undefined) {
            const ref: ImageAttachmentRef = await attachments.saveImage({
              data,
              mediaType,
              name: saved.fileName,
            })
            images.push({ type: 'image', attachment: ref })
          }
        }
      } catch (error) {
        const name = resource.fileName ?? resource.type
        notes.push(`- ${name}: 接收失败（${bounded(errorMessage(error), 240)}）`)
      }
    }

    const parts: string[] = []
    if (message.content.trim() !== '') parts.push(message.content.trim())
    if (notes.length > 0) {
      parts.push(`<lark_attachments>\n${notes.join('\n')}\n</lark_attachments>`)
      if (!this.config.nativeImageInput && message.resources.some(resource => resource.type === 'image' || resource.type === 'sticker')) {
        parts.push('当前模型路线按文件路径接收图片；如需理解图片内容，请使用可用的图片读取能力或切换支持图像输入的模型。')
      }
    }
    const text = parts.join('\n\n') || '[飞书发送了一个无文本附件]'
    return [{ type: 'text', text }, ...images]
  }

  private async handleCommand(message: NormalizedMessage, line: string, project: ResolvedProject): Promise<void> {
    const [command = '', ...args] = line.trim().split(/\s+/u)
    const argument = args.join(' ').trim()
    switch (command.toLowerCase()) {
      case '/start':
      case '/help':
        await this.safeSend(message.chatId, { markdown: HELP_TEXT }, message)
        return
      case '/new': {
        const entry = await this.ensureSession(message, project)
        await this.rotateSession(entry)
        await this.safeSend(message.chatId, { markdown: `✅ 已创建新会话：\`${entry.sessionId}\`` }, message)
        return
      }
      case '/stop': {
        const entry = this.sessions.get(originKey(message, this.config.groupSessionScope, project.id))
        if (entry === undefined || entry.handle.agent.status === 'idle') {
          await this.safeSend(message.chatId, { markdown: '当前没有运行中的任务。' }, message)
          return
        }
        entry.handle.agent.cancel({ kind: 'user' })
        await this.safeSend(message.chatId, { markdown: '⏹️ 已向当前 Harness 任务发送停止请求。' }, message)
        return
      }
      case '/approve':
      case '/reject': {
        const key = originKey(message, this.config.groupSessionScope, project.id)
        const pending = [...this.pendingApprovals.values()].find(item => (
          item.entry.key === key
          && item.expectedOpenId === message.senderId
          && isAuthorizedAction(item.entry, message.senderId, message.chatId, this.config)
        ))
        if (pending === undefined) {
          await this.safeSend(message.chatId, { markdown: '当前飞书会话没有等待处理的工具审批。' }, message)
          return
        }
        const allowed = command.toLowerCase() === '/approve'
        this.settleApproval(pending, allowed ? 'allowed-once' : 'rejected')
        await this.safeSend(message.chatId, {
          markdown: allowed ? '✅ 已仅允许当前这一次操作。' : '⛔ 已拒绝当前这一次操作。',
        }, message)
        return
      }
      case '/status': {
        const entry = await this.ensureSession(message, project)
        await this.sendStatus(entry, message)
        return
      }
      case '/steer': {
        if (argument === '') {
          await this.safeSend(message.chatId, { markdown: '用法：`/steer <补充或纠正内容>`' }, message)
          return
        }
        const entry = await this.ensureSession(message, project)
        entry.handle.agent.steer(createUserMessage({
          content: [{ type: 'text', text: argument }],
          source: { kind: 'user' },
        }))
        await this.safeSend(message.chatId, { markdown: '🧭 已把补充内容送到 Agent 的最近一步。' }, message)
        return
      }
      case '/sessions': {
        const key = originKey(message, this.config.groupSessionScope, project.id)
        const prefix = sessionPrefix(key)
        const rows = sessionsForPrefix(this.headers, prefix).slice(0, 8)
        const body = rows.length === 0
          ? '还没有持久化的历史会话。'
          : rows.map(header => `- \`${header.id}\` · ${new Date(header.createdAt).toLocaleString('zh-CN')}`).join('\n')
        await this.safeSend(message.chatId, { markdown: `## 历史 Session\n${body}` }, message)
        return
      }
      case '/resume': {
        if (argument === '') {
          await this.safeSend(message.chatId, { markdown: '用法：`/resume <session-id>`' }, message)
          return
        }
        const entry = await this.ensureSession(message, project)
        const target = this.headers.find(header => String(header.id) === argument)
        if (target === undefined || !String(target.id).startsWith(`${entry.prefix}-`)) {
          await this.safeSend(message.chatId, { markdown: '找不到属于当前飞书会话的该 Session。' }, message)
          return
        }
        await this.resumeSession(entry, target)
        await this.safeSend(message.chatId, { markdown: `✅ 已恢复会话：\`${entry.sessionId}\`` }, message)
        return
      }
      case '/projects': {
        const current = this.projectForMessage(message)
        const rows = this.availableProjects(message.senderId).map(item => (
          `- ${item.id === current.id ? '✅' : '▫️'} \`${item.id}\` — ${item.name}`
        )).join('\n')
        await this.safeSend(message.chatId, {
          markdown: `## Harness Projects\n${rows}\n\n${message.chatType === 'p2p' ? '私聊中使用 `/project <id>` 切换。' : '群聊与 Project 固定绑定，不能在群内切换。'}`,
        }, message)
        return
      }
      case '/project': {
        if (argument === '') {
          await this.safeSend(message.chatId, {
            markdown: `当前 Project：**${project.name}**（\`${project.id}\`）\n\n使用 \`/projects\` 查看全部项目。`,
          }, message)
          return
        }
        if (message.chatType !== 'p2p') {
          await this.safeSend(message.chatId, { markdown: '群聊已固定绑定 Project；请在对应项目群中创建或进入话题。' }, message)
          return
        }
        const target = this.availableProjects(message.senderId).find(item => item.id === argument)
        if (target === undefined) {
          await this.safeSend(message.chatId, { markdown: `未知 Project \`${argument}\`。使用 \`/projects\` 查看可选项。` }, message)
          return
        }
        this.selectedProjects.set(message.senderId, target.id)
        await this.safeSend(message.chatId, {
          markdown: `✅ 已切换到 **${target.name}**（\`${target.id}\`）。后续私聊会进入该 Project。`,
        }, message)
        return
      }
      case '/view': {
        const entry = await this.ensureSession(message, project)
        if (argument === '') {
          await this.safeSend(message.chatId, {
            markdown: `当前卡片视图：\`${entry.cardPreset}\`。用法：\`/view compact|standard|developer\``,
          }, message)
          return
        }
        if (!isCardPreset(argument)) {
          await this.safeSend(message.chatId, { markdown: '视图必须是 `compact`、`standard` 或 `developer`。' }, message)
          return
        }
        entry.cardPreset = argument
        if (entry.progress !== undefined && entry.progress.progressMessageId !== undefined) {
          await this.upsertTurnCard(entry, entry.progress)
        }
        await this.safeSend(message.chatId, { markdown: `✅ 当前 Session 已切换为 \`${argument}\` 视图。` }, message)
        return
      }
      case '/commands': {
        const entry = await this.ensureSession(message, project)
        const commands = this.ctx.get('commands')?.list(entry.handle.agent) ?? []
        const body = commands.length === 0
          ? '当前 Agent 没有注册额外命令。'
          : commands.map(item => `- \`/${item.name}\` — ${item.description}`).join('\n')
        await this.safeSend(message.chatId, { markdown: `## Harness 原生命令\n${body}` }, message)
        return
      }
      default: {
        const entry = await this.ensureSession(message, project)
        const commands = this.ctx.get('commands')
        const execution = commands === undefined
          ? undefined
          : await commands.execute(entry.handle.agent, line, new AbortController().signal)
        if (execution === undefined) {
          await this.safeSend(message.chatId, { markdown: `未知命令 \`${command}\`。发送 \`/help\` 查看可用控制。` }, message)
          return
        }
        const result = execution.result
        await this.safeSend(message.chatId, {
          markdown: result.text ?? (result.kind === 'success' ? '✅ 命令已执行。' : '❌ 命令执行失败。'),
        }, message)
      }
    }
  }

  private async ensureSession(message: NormalizedMessage, project = this.projectForMessage(message)): Promise<BridgeSession> {
    const key = originKey(message, this.config.groupSessionScope, project.id)
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    const pending = this.creating.get(key)
    if (pending !== undefined) return pending
    const creating = this.createSession(message, key, project)
    this.creating.set(key, creating)
    try {
      return await creating
    } finally {
      this.creating.delete(key)
    }
  }

  private async createSession(message: NormalizedMessage, key: string, project: ResolvedProject): Promise<BridgeSession> {
    const prefix = sessionPrefix(key)
    const latest = latestSession(this.headers, prefix)
    const route: RouteContext = {
      chatId: message.chatId,
      chatType: message.chatType,
      ownerOpenId: message.senderId,
      replyTo: message.messageId,
      replyInThread: this.shouldReplyInThread(message),
    }
    const selection = this.modelSelection(project)
    const setup = async (agentCtx: Context) => this.setupAgent(agentCtx, route, project)
    const handle = latest === undefined
      ? await this.ctx.agents.create({
        sessionId: this.nextSessionId(prefix),
        meta: { cwd: project.cwd },
        agentOptions: selection,
        setup,
      })
      : await this.ctx.agents.resume({
        resumeSessionId: latest.id,
        agentOptions: selection,
        setup,
      })
    const entry: BridgeSession = {
      key,
      prefix,
      route,
      project,
      handle,
      sessionId: String(handle.agent.id),
      cardPreset: project.cardPreset,
      pendingPrompt: '飞书任务',
      outbound: Promise.resolve(),
    }
    this.sessions.set(key, entry)
    this.agents.set(entry.sessionId, entry)
    this.rememberHeader(handle.agent)
    return entry
  }

  private modelSelection(project?: ResolvedProject): { provider: string; model: string } {
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    return {
      provider: project?.provider ?? this.config.provider ?? fallback.provider,
      model: project?.model ?? this.config.model ?? fallback.model,
    }
  }

  private async setupAgent(agentCtx: Context, route: RouteContext, project: ResolvedProject): Promise<void> {
    const channel = this.channel
    const config = this.config
    await agentCtx.plugin(toolAskUser)
    agentCtx.systemPrompt.section({
      name: 'tool:lark-deliver',
      order: 118,
      text: 'The user is interacting through Feishu/Lark. Your ordinary assistant text is delivered automatically. Use lark_deliver only to send a workspace file/image or a deliberately separate message. Never include credentials or secrets in outbound content.',
    })
    agentCtx.tools.register(defineTool({
      name: 'lark_deliver',
      description: 'Send a separate Markdown message or a local workspace file/image to the current Feishu conversation. Ordinary assistant replies are delivered automatically, so use this only for attachments or intentionally separate messages.',
      parameters: {
        text: { type: 'string', description: 'Optional Markdown message or caption.' },
        file_path: { type: 'string', description: 'Optional local file path. It must resolve inside the configured workspace root.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean', required: true },
            kind: { type: 'string', enum: ['text', 'image', 'file', 'text+image', 'text+file'], required: true },
            messageIds: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Delivered ${value.kind} to the current Lark conversation (${value.messageIds.length} message${value.messageIds.length === 1 ? '' : 's'}).`,
        }],
      },
      async execute(args, exec) {
        const text = args.text?.trim()
        const requestedPath = args.file_path?.trim()
        if ((text === undefined || text === '') && (requestedPath === undefined || requestedPath === '')) {
          throw new Error('text or file_path is required')
        }
        exec.signal.throwIfAborted()
        const messageIds: string[] = []
        const sendOptions = {
          ...(route.replyTo === undefined ? {} : { replyTo: route.replyTo }),
          replyInThread: route.replyInThread,
        }
        if (text !== undefined && text !== '') {
          const result = await channel.send(route.chatId, { markdown: redactSecrets(text) }, sendOptions)
          messageIds.push(result.messageId)
        }
        let fileKind: 'image' | 'file' | undefined
        if (requestedPath !== undefined && requestedPath !== '') {
          const cwd = exec.agent?.session.header.cwd ?? project.cwd
          const file = await resolveOutboundFile(
            project.workspaceRoot,
            cwd,
            requestedPath,
            config.maxOutboundFileBytes,
          )
          exec.signal.throwIfAborted()
          fileKind = isImageFileName(file.fileName) ? 'image' : 'file'
          const result = fileKind === 'image'
            ? await channel.send(route.chatId, { image: { source: file.absolutePath } }, sendOptions)
            : await channel.send(route.chatId, { file: { source: file.absolutePath, fileName: file.fileName } }, sendOptions)
          messageIds.push(result.messageId)
        }
        const kind: 'text' | 'image' | 'file' | 'text+image' | 'text+file' = fileKind === undefined
          ? 'text'
          : text === undefined || text === ''
            ? fileKind
            : `text+${fileKind}` as const
        return { sent: true, kind, messageIds }
      },
    }))
  }

  private nextSessionId(prefix: string): SessionId {
    let now = Date.now()
    const known = new Set(this.headers.map(header => String(header.id)))
    let id = freshSessionId(prefix, now)
    while (known.has(String(id))) id = freshSessionId(prefix, ++now)
    return id
  }

  private rememberHeader(agent: Agent): void {
    const header = agent.session.header
    const index = this.headers.findIndex(item => item.id === header.id)
    if (index >= 0) this.headers[index] = header
    else this.headers.push(header)
  }

  private async rotateSession(entry: BridgeSession): Promise<void> {
    this.agents.delete(entry.sessionId)
    if (entry.progressTimer !== undefined) clearTimeout(entry.progressTimer)
    entry.handle.agent.cancel({ kind: 'user' })
    await entry.handle.dispose()
    const selection = this.modelSelection(entry.project)
    const handle = await this.ctx.agents.create({
      sessionId: this.nextSessionId(entry.prefix),
      meta: { cwd: entry.project.cwd },
      agentOptions: selection,
      setup: async agentCtx => this.setupAgent(agentCtx, entry.route, entry.project),
    })
    entry.handle = handle
    entry.sessionId = String(handle.agent.id)
    entry.progress = undefined
    entry.pendingPrompt = '飞书任务'
    this.agents.set(entry.sessionId, entry)
    this.rememberHeader(handle.agent)
  }

  private async resumeSession(entry: BridgeSession, header: SessionHeader): Promise<void> {
    if (entry.sessionId === String(header.id)) return
    this.agents.delete(entry.sessionId)
    if (entry.progressTimer !== undefined) clearTimeout(entry.progressTimer)
    entry.handle.agent.cancel({ kind: 'user' })
    await entry.handle.dispose()
    const handle = await this.ctx.agents.resume({
      resumeSessionId: header.id,
      agentOptions: this.modelSelection(entry.project),
      setup: async agentCtx => this.setupAgent(agentCtx, entry.route, entry.project),
    })
    entry.handle = handle
    entry.sessionId = String(handle.agent.id)
    entry.progress = undefined
    this.agents.set(entry.sessionId, entry)
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const entry = this.agents.get(String(session.id))
    if (entry === undefined) return
    switch (event.type) {
      case 'turn/start': {
        const progress: TurnProgress = {
          turn: event.data.turn,
          startedAt: event.time,
          prompt: entry.pendingPrompt,
          visibleText: '',
          tools: [],
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          terminal: false,
        }
        entry.progress = progress
        if (this.config.progressCards) {
          void this.enqueue(entry, '发送进度卡片', () => this.upsertTurnCard(entry, progress))
        }
        break
      }
      case 'assistant/chunk': {
        const progress = entry.progress
        if (progress === undefined || event.data.chunk.type !== 'text-delta') break
        progress.visibleText += event.data.chunk.text
        this.scheduleProgress(entry, progress)
        break
      }
      case 'tool/call': {
        const progress = entry.progress
        if (progress === undefined) break
        progress.tools.push({
          callId: String(event.data.callId),
          name: event.data.name,
          summary: toolSummary(event.data.arguments),
          startedAt: event.time,
        })
        this.scheduleProgress(entry, progress)
        break
      }
      case 'tool/result': {
        const progress = entry.progress
        if (progress === undefined) break
        const callId = String(event.data.message.source.callId)
        const tool = progress.tools.findLast(item => item.callId === callId)
        if (tool !== undefined) {
          tool.finishedAt = event.time
          tool.failed = event.data.error !== undefined || event.data.message.content[0]?.isError === true
        }
        this.scheduleProgress(entry, progress)
        break
      }
      case 'assistant/message': {
        const progress = entry.progress
        if (progress === undefined) break
        const final = assistantText(event)
        if (final !== '' && !progress.visibleText.endsWith(final)) progress.visibleText += final
        const usage = event.data.usage
        if (usage !== undefined) {
          progress.inputTokens += usage.inputTokens
          progress.outputTokens += usage.outputTokens
          progress.cacheReadTokens += usage.cacheReadTokens ?? 0
        }
        this.scheduleProgress(entry, progress)
        break
      }
      case 'turn/end': {
        const progress = entry.progress
        if (progress === undefined) break
        progress.terminal = true
        if (entry.progressTimer !== undefined) {
          clearTimeout(entry.progressTimer)
          entry.progressTimer = undefined
        }
        const terminal = terminalOutcome(event.data.reason)
        progress.outcome = terminal.outcome
        progress.outcomeDetail = terminal.detail
        void this.enqueue(entry, '发送完成卡片', async () => {
          if (this.config.progressCards) {
            await this.upsertTurnCard(entry, progress, terminal.outcome, terminal.detail)
          } else {
            const text = redactSecrets(progress.visibleText).trim()
            await this.channel.send(entry.route.chatId, {
              markdown: text === '' ? `Harness 任务${terminal.outcome === 'completed' ? '已完成' : '已结束'}。` : text,
            }, this.replyOptions(entry))
          }
          const safeText = redactSecrets(progress.visibleText)
          if (safeText.length > this.config.cardBodyMaxChars) {
            await this.channel.send(entry.route.chatId, {
              file: {
                source: boundedUtf8Buffer(safeText, this.config.maxOutboundFileBytes),
                fileName: 'deepseek-harness-response.md',
              },
            }, this.replyOptions(entry))
          }
        })
        break
      }
      default:
        break
    }
  }

  private scheduleProgress(entry: BridgeSession, progress: TurnProgress): void {
    if (!this.config.progressCards || progress.terminal || entry.progressTimer !== undefined) return
    entry.progressTimer = setTimeout(() => {
      entry.progressTimer = undefined
      if (!progress.terminal) void this.enqueue(entry, '更新进度卡片', () => this.upsertTurnCard(entry, progress))
    }, this.config.progressUpdateMs)
  }

  private async upsertTurnCard(
    entry: BridgeSession,
    progress: TurnProgress,
    outcome?: 'completed' | 'cancelled' | 'blocked' | 'error',
    detail?: string,
  ): Promise<void> {
    const selection = this.modelSelection(entry.project)
    const resolvedOutcome = outcome ?? progress.outcome
    const resolvedDetail = detail ?? progress.outcomeDetail
    const card = buildTurnCard({
      progress,
      sessionId: entry.sessionId,
      cwd: entry.handle.agent.session.header.cwd ?? entry.project.cwd,
      model: selection.model,
      project: entry.project.name,
      preset: entry.cardPreset,
      ...(resolvedOutcome === undefined ? {} : { outcome: resolvedOutcome }),
      ...(resolvedDetail === undefined ? {} : { outcomeDetail: resolvedDetail }),
      maxBodyChars: this.config.cardBodyMaxChars,
    })
    if (progress.progressMessageId === undefined) {
      const sent = await this.channel.send(entry.route.chatId, { card }, this.replyOptions(entry))
      progress.progressMessageId = sent.messageId
    } else {
      await this.channel.updateCard(progress.progressMessageId, card)
    }
  }

  private async enqueue(entry: BridgeSession, label: string, operation: () => Promise<void>): Promise<void> {
    const job = entry.outbound.then(operation)
    entry.outbound = job.catch(error => {
      this.ctx.logger.error('[dsh-lark-bridge] %s失败：%s', label, errorMessage(error))
    })
    return job
  }

  private replyOptions(entry: BridgeSession): { replyTo?: string; replyInThread?: boolean } {
    return {
      ...(entry.route.replyTo === undefined ? {} : { replyTo: entry.route.replyTo }),
      ...(entry.route.replyInThread ? { replyInThread: true } : {}),
    }
  }

  private async sendStatus(entry: BridgeSession, message?: NormalizedMessage): Promise<void> {
    const selection = this.modelSelection(entry.project)
    const card = buildStatusCard({
      sessionId: entry.sessionId,
      status: entry.handle.agent.status,
      cwd: entry.handle.agent.session.header.cwd ?? entry.project.cwd,
      provider: selection.provider,
      model: selection.model,
      connected: this.connected,
      pendingApprovals: [...this.pendingApprovals.values()].filter(item => item.entry === entry).length,
      pendingQuestions: [...this.pendingQuestions.values()].filter(item => item.entry === entry).length,
      project: entry.project.name,
      preset: entry.cardPreset,
    })
    await this.channel.send(entry.route.chatId, { card }, message === undefined ? this.replyOptions(entry) : {
      replyTo: message.messageId,
      replyInThread: this.shouldReplyInThread(message),
    })
  }

  private async askApproval(entry: BridgeSession, request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (!isAuthorizedAction(entry, entry.route.ownerOpenId, entry.route.chatId, this.config)) return 'unavailable'
    const token = randomUUID()
    return await new Promise<ApprovalOutcome>((resolve) => {
      const pending: PendingApproval = {
        token,
        entry,
        expectedOpenId: entry.route.ownerOpenId,
        toolName: request.toolName,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        timer: setTimeout(() => this.settleApproval(pending, 'unavailable'), this.config.interactiveTimeoutMs),
        resolve,
      }
      if (request.signal !== undefined) {
        pending.onAbort = () => this.settleApproval(pending, 'cancelled')
        request.signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.pendingApprovals.set(token, pending)
      void this.channel.send(entry.route.chatId, {
        card: buildApprovalCard({
          token,
          toolName: request.toolName,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          sessionId: entry.sessionId,
        }),
      }, this.replyOptions(entry)).then(
        sent => { pending.messageId = sent.messageId },
        () => this.settleApproval(pending, 'unavailable'),
      )
    })
  }

  private settleApproval(pending: PendingApproval, outcome: ApprovalOutcome): void {
    if (!this.pendingApprovals.delete(pending.token)) return
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    if (pending.messageId !== undefined) {
      void this.channel.updateCard(pending.messageId, buildApprovalCard({
        token: pending.token,
        toolName: pending.toolName,
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        sessionId: pending.entry.sessionId,
        settled: outcome === 'allowed-once' ? 'allowed' : outcome,
      })).catch(() => undefined)
    }
    pending.resolve(outcome)
  }

  private async askQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    const entry = agent === undefined ? undefined : this.agents.get(String(agent.id))
    if (entry === undefined) throw new Error('Lark question provider only answers for Lark-owned Harness agents')
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      answers.push(await this.askOneQuestion(entry, question, request.signal))
    }
    return { answers }
  }

  private async askOneQuestion(
    entry: BridgeSession,
    question: AskUserQuestionItem,
    signal?: AbortSignal,
  ): Promise<AskUserQuestionAnswerItem> {
    signal?.throwIfAborted()
    const token = randomUUID()
    return await new Promise<AskUserQuestionAnswerItem>((resolve, reject) => {
      const pending: PendingQuestion = {
        token,
        entry,
        expectedOpenId: entry.route.ownerOpenId,
        question,
        selected: new Set(),
        ...(signal === undefined ? {} : { signal }),
        timer: setTimeout(
          () => this.rejectQuestion(pending, new Error('Timed out waiting for a Lark answer')),
          this.config.interactiveTimeoutMs,
        ),
        resolve,
        reject,
      }
      if (signal !== undefined) {
        pending.onAbort = () => this.rejectQuestion(pending, new Error('Question was cancelled'))
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.pendingQuestions.set(token, pending)
      void this.channel.send(entry.route.chatId, {
        card: buildQuestionCard({ token, question }),
      }, this.replyOptions(entry)).then(
        sent => { pending.messageId = sent.messageId },
        error => this.rejectQuestion(pending, new Error(`Unable to send Lark question: ${errorMessage(error)}`)),
      )
    })
  }

  private settleQuestion(pending: PendingQuestion, answer: AskUserQuestionAnswerItem, display: string): void {
    if (!this.pendingQuestions.delete(pending.token)) return
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    if (pending.messageId !== undefined) {
      void this.channel.updateCard(pending.messageId, buildQuestionCard({
        token: pending.token,
        question: pending.question,
        settled: display,
      })).catch(() => undefined)
    }
    pending.resolve(answer)
  }

  private rejectQuestion(pending: PendingQuestion, error: Error): void {
    if (!this.pendingQuestions.delete(pending.token)) return
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    pending.reject(error)
  }

  private onCardAction(event: CardActionEvent): void {
    const action = parseBridgeAction(event.action.value)
    if (action === undefined) return
    if (action.action === 'approval') {
      const pending = this.pendingApprovals.get(action.token)
      if (pending === undefined || !isAuthorizedAction(pending.entry, event.operator.openId, event.chatId, this.config)
        || event.operator.openId !== pending.expectedOpenId) return
      this.settleApproval(pending, action.decision === 'allow' ? 'allowed-once' : 'rejected')
      return
    }
    if (action.action === 'question-option' || action.action === 'question-submit') {
      this.handleQuestionAction(event, action)
      return
    }
    const entry = this.agents.get(action.sessionId)
    if (entry === undefined || !isAuthorizedAction(entry, event.operator.openId, event.chatId, this.config)) return
    if (action.action === 'stop') {
      entry.handle.agent.cancel({ kind: 'user' })
      void this.channel.send(entry.route.chatId, { markdown: '⏹️ 已发送停止请求。' }, this.replyOptions(entry)).catch(error => {
        this.ctx.logger.error('[dsh-lark-bridge] 回复停止操作失败：%s', errorMessage(error))
      })
    } else if (action.action === 'new') {
      void this.rotateSession(entry).then(() => (
        this.channel.send(entry.route.chatId, { markdown: `✅ 已创建新会话：\`${entry.sessionId}\`` }, this.replyOptions(entry))
      )).catch(error => {
        this.ctx.logger.error('[dsh-lark-bridge] 创建新会话失败：%s', errorMessage(error))
      })
    } else if (action.action === 'status') {
      void this.sendStatus(entry).catch(error => {
        this.ctx.logger.error('[dsh-lark-bridge] 回复会话状态失败：%s', errorMessage(error))
      })
    } else {
      entry.cardPreset = nextCardPreset(entry.cardPreset)
      const refresh = entry.progress === undefined
        ? this.channel.send(entry.route.chatId, { markdown: `卡片视图已切换为 \`${entry.cardPreset}\`。` }, this.replyOptions(entry)).then(() => undefined)
        : this.upsertTurnCard(entry, entry.progress)
      void refresh.catch(error => {
        this.ctx.logger.error('[dsh-lark-bridge] 切换卡片视图失败：%s', errorMessage(error))
      })
    }
  }

  private handleQuestionAction(
    event: CardActionEvent,
    action: Extract<BridgeAction, { action: 'question-option' | 'question-submit' }>,
  ): void {
    const pending = this.pendingQuestions.get(action.token)
    if (pending === undefined || !isAuthorizedAction(pending.entry, event.operator.openId, event.chatId, this.config)
      || event.operator.openId !== pending.expectedOpenId) return
    if (action.action === 'question-option') {
      const option = pending.question.options?.[action.index]
      if (option === undefined) return
      if (pending.question.multiSelect) {
        if (pending.selected.has(action.index)) pending.selected.delete(action.index)
        else pending.selected.add(action.index)
        if (pending.messageId !== undefined) {
          void this.channel.updateCard(pending.messageId, buildQuestionCard({
            token: pending.token,
            question: pending.question,
            selected: pending.selected,
          })).catch(() => undefined)
        }
        return
      }
      this.settleQuestion(pending, {
        id: pending.question.id,
        selected: [option.label],
      }, option.label)
      return
    }
    if (pending.selected.size === 0) {
      void this.channel.send(pending.entry.route.chatId, { markdown: '请至少选择一项后再提交。' }, this.replyOptions(pending.entry)).catch(error => {
        this.ctx.logger.error('[dsh-lark-bridge] 回复问题操作失败：%s', errorMessage(error))
      })
      return
    }
    const selected = [...pending.selected]
      .sort((left, right) => left - right)
      .flatMap(index => pending.question.options?.[index]?.label ?? [])
    this.settleQuestion(pending, { id: pending.question.id, selected }, selected.join('、'))
  }

  private onReaction(event: ReactionEvent): void {
    if (event.action !== 'added' || !['CrossMark', 'STOP', 'NO'].includes(event.emojiType)) return
    const entry = [...this.sessions.values()].find(item => item.progress?.progressMessageId === event.messageId)
    if (entry === undefined) return
    const allowed = isOpenIdAllowed(
      event.operator.openId,
      this.config.allowAllUsers,
      this.config.allowedOpenIds,
      entry.project.allowedOpenIds,
    )
    if (!allowed || (this.config.groupSessionScope !== 'chat' && entry.route.ownerOpenId !== event.operator.openId)) return
    entry.handle.agent.cancel({ kind: 'user' })
  }

  private async safeSend(
    chatId: string,
    input: Parameters<LarkChannelLike['send']>[1],
    message?: NormalizedMessage,
  ): Promise<void> {
    try {
      await this.channel.send(chatId, input, message === undefined ? undefined : {
        replyTo: message.messageId,
        replyInThread: this.shouldReplyInThread(message),
      })
    } catch (error) {
      this.ctx.logger.error('[dsh-lark-bridge] 发送飞书消息失败：%s', errorMessage(error))
    }
  }
}

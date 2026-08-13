import type {
  CardActionEvent,
  EventMap,
  LarkChannel,
  NormalizedMessage,
  SendInput,
  SendOptions,
  SendResult,
} from '@larksuiteoapi/node-sdk'

export type CardPreset = 'compact' | 'standard' | 'developer'
export type GroupSessionScope = 'chat' | 'sender' | 'thread'

/** One stable Harness project exposed through one or more Lark chats. */
export interface ResolvedProject {
  id: string
  name: string
  chatIds: string[]
  allowedOpenIds: string[]
  provider?: string
  model?: string
  cwd: string
  workspaceRoot: string
  inboundDir: string
  cardPreset: CardPreset
}

/** Runtime configuration after environment fallbacks and path normalization. */
export interface ResolvedConfig {
  appId: string
  appSecret: string
  allowedOpenIds: string[]
  allowedChatIds: string[]
  allowAllUsers: boolean
  allowAllGroups: boolean
  requireMention: boolean
  groupSessionScope: GroupSessionScope
  provider?: string
  model?: string
  cwd: string
  workspaceRoot: string
  inboundDir: string
  nativeImageInput: boolean
  progressCards: boolean
  progressUpdateMs: number
  maxInboundFileBytes: number
  maxOutboundFileBytes: number
  interactiveTimeoutMs: number
  provideUserQuestions: boolean
  enableApprovals: boolean
  cardBodyMaxChars: number
  cardPreset: CardPreset
  defaultProjectId: string
  projects: ResolvedProject[]
}

/** Narrow seam around the official SDK, allowing deterministic bridge tests. */
export interface LarkChannelLike {
  readonly botIdentity?: LarkChannel['botIdentity']
  connect(): Promise<void>
  disconnect(): Promise<void>
  on<K extends keyof EventMap>(name: K, handler: EventMap[K]): () => void
  send(to: string, input: SendInput, options?: SendOptions): Promise<SendResult>
  updateCard(messageId: string, card: object): Promise<void>
  downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    maxBytes: number,
  ): Promise<Buffer>
}

export interface ToolProgress {
  callId: string
  name: string
  summary: string
  startedAt: number
  finishedAt?: number
  failed?: boolean
}

export interface TurnProgress {
  turn: number
  startedAt: number
  prompt: string
  visibleText: string
  tools: ToolProgress[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  progressMessageId?: string
  terminal: boolean
  outcome?: 'completed' | 'cancelled' | 'blocked' | 'error'
  outcomeDetail?: string
}

export type BridgeAction =
  | { bridge: 'dsh-lark-bridge'; action: 'stop' | 'new' | 'status' | 'view'; sessionId: string }
  | { bridge: 'dsh-lark-bridge'; action: 'approval'; token: string; decision: 'allow' | 'reject' }
  | { bridge: 'dsh-lark-bridge'; action: 'question-option'; token: string; index: number }
  | { bridge: 'dsh-lark-bridge'; action: 'question-submit'; token: string }

export type ChannelFactory = (config: ResolvedConfig) => LarkChannelLike

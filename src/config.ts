import { resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { CardPreset, GroupSessionScope, ResolvedConfig, ResolvedProject } from './types.js'
import { isInside, parseBooleanEnv, parseCsv } from './security.js'

/** Public Cordis configuration. Credentials should normally come from environment variables. */
export interface Config {
  appId?: string
  appSecret?: string
  allowedOpenIds?: string[]
  allowedChatIds?: string[]
  allowAllUsers?: boolean
  allowAllGroups?: boolean
  requireMention?: boolean
  groupSessionScope?: GroupSessionScope
  provider?: string
  model?: string
  cwd?: string
  workspaceRoot?: string
  inboundDir?: string
  nativeImageInput?: boolean
  progressCards?: boolean
  progressUpdateMs?: number
  maxInboundFileBytes?: number
  maxOutboundFileBytes?: number
  interactiveTimeoutMs?: number
  provideUserQuestions?: boolean
  enableApprovals?: boolean
  cardBodyMaxChars?: number
  cardPreset?: CardPreset
  defaultProjectId?: string
  projects?: ProjectConfig[]
}

/** A stable project binding. Group chats listed here are routed only to this project. */
export interface ProjectConfig {
  id: string
  name?: string
  chatIds?: string[]
  allowedOpenIds?: string[]
  provider?: string
  model?: string
  cwd?: string
  workspaceRoot?: string
  inboundDir?: string
  cardPreset?: CardPreset
}

const ProjectSchema: Schema<ProjectConfig> = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().default(''),
  chatIds: Schema.array(Schema.string()).default([]),
  allowedOpenIds: Schema.array(Schema.string()).default([]),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  cwd: Schema.string().default(''),
  workspaceRoot: Schema.string().default(''),
  inboundDir: Schema.string().default(''),
  cardPreset: Schema.union(['compact', 'standard', 'developer'] as const).default('standard'),
})

export const ConfigSchema: Schema<Config> = Schema.object({
  appId: Schema.string().default(''),
  appSecret: Schema.string().default(''),
  allowedOpenIds: Schema.array(Schema.string()).default([]),
  allowedChatIds: Schema.array(Schema.string()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  allowAllGroups: Schema.boolean().default(false),
  requireMention: Schema.boolean().default(true),
  groupSessionScope: Schema.union(['chat', 'sender', 'thread'] as const).default('thread'),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  cwd: Schema.string().default(''),
  workspaceRoot: Schema.string().default(''),
  inboundDir: Schema.string().default(''),
  nativeImageInput: Schema.boolean().default(false),
  progressCards: Schema.boolean().default(true),
  progressUpdateMs: Schema.number().step(1).min(250).default(1000),
  maxInboundFileBytes: Schema.number().step(1).min(1).default(20 * 1024 * 1024),
  maxOutboundFileBytes: Schema.number().step(1).min(1).default(30 * 1024 * 1024),
  interactiveTimeoutMs: Schema.number().step(1).min(1000).default(10 * 60 * 1000),
  provideUserQuestions: Schema.boolean().default(true),
  enableApprovals: Schema.boolean().default(true),
  cardBodyMaxChars: Schema.number().step(1).min(1000).max(28000).default(12000),
  cardPreset: Schema.union(['compact', 'standard', 'developer'] as const).default('standard'),
  defaultProjectId: Schema.string().default(''),
  projects: Schema.array(ProjectSchema).default([]),
})

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function cleanId(value: string): string {
  const id = value.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(id)) {
    throw new Error(`dsh-lark-bridge: invalid project id ${JSON.stringify(value)}`)
  }
  return id
}

function resolveProject(
  input: ProjectConfig,
  defaults: {
    provider?: string
    model?: string
    cwd: string
    workspaceRoot: string
    inboundDir: string
    cardPreset: CardPreset
  },
): ResolvedProject {
  const id = cleanId(input.id)
  const cwd = resolve(input.cwd || defaults.cwd)
  const workspaceRoot = resolve(input.workspaceRoot || (input.cwd === undefined || input.cwd === '' ? defaults.workspaceRoot : cwd))
  const inboundDir = resolve(cwd, input.inboundDir || defaults.inboundDir)
  if (!isInside(workspaceRoot, cwd)) {
    throw new Error(`dsh-lark-bridge: project ${id} cwd must be inside workspaceRoot`)
  }
  if (!isInside(workspaceRoot, inboundDir)) {
    throw new Error(`dsh-lark-bridge: project ${id} inboundDir must be inside workspaceRoot`)
  }
  const provider = input.provider?.trim() || defaults.provider
  const model = input.model?.trim() || defaults.model
  return {
    id,
    name: input.name?.trim() || id,
    chatIds: unique(input.chatIds ?? []),
    allowedOpenIds: unique(input.allowedOpenIds ?? []),
    ...(provider === undefined || provider === '' ? {} : { provider }),
    ...(model === undefined || model === '' ? {} : { model }),
    cwd,
    workspaceRoot,
    inboundDir,
    cardPreset: input.cardPreset ?? defaults.cardPreset,
  }
}

/** Resolve schema-normalized config with environment-only secrets and allowlists. */
export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const appId = (config.appId || env.DSH_LARK_APP_ID || '').trim()
  const appSecret = (config.appSecret || env.DSH_LARK_APP_SECRET || '').trim()
  if (appId === '') throw new Error('dsh-lark-bridge: missing app id (set DSH_LARK_APP_ID)')
  if (appSecret === '') throw new Error('dsh-lark-bridge: missing app secret (set DSH_LARK_APP_SECRET)')

  const cwd = resolve(config.cwd || process.cwd())
  const workspaceRoot = resolve(config.workspaceRoot || cwd)
  const inboundDir = resolve(cwd, config.inboundDir || '.dsh-lark-bridge/inbox')
  if (!isInside(workspaceRoot, cwd)) {
    throw new Error('dsh-lark-bridge: cwd must be inside workspaceRoot')
  }
  if (!isInside(workspaceRoot, inboundDir)) {
    throw new Error('dsh-lark-bridge: inboundDir must be inside workspaceRoot')
  }
  const provider = config.provider?.trim()
  const model = config.model?.trim()
  const cardPreset = config.cardPreset ?? 'standard'
  const configuredAllowedChatIds = unique([
    ...(config.allowedChatIds ?? []),
    ...parseCsv(env.DSH_LARK_ALLOWED_CHAT_IDS),
  ])
  const defaults = {
    ...(provider === undefined || provider === '' ? {} : { provider }),
    ...(model === undefined || model === '' ? {} : { model }),
    cwd,
    workspaceRoot,
    inboundDir: config.inboundDir || '.dsh-lark-bridge/inbox',
    cardPreset,
  }
  const projects = (config.projects?.length ?? 0) === 0
    ? [resolveProject({ id: 'default', name: 'Default', chatIds: configuredAllowedChatIds }, defaults)]
    : config.projects!.map(project => resolveProject(project, defaults))
  const projectIds = new Set<string>()
  const chatOwners = new Map<string, string>()
  for (const project of projects) {
    if (projectIds.has(project.id)) throw new Error(`dsh-lark-bridge: duplicate project id ${project.id}`)
    projectIds.add(project.id)
    for (const chatId of project.chatIds) {
      const owner = chatOwners.get(chatId)
      if (owner !== undefined) throw new Error(`dsh-lark-bridge: chat ${chatId} belongs to both ${owner} and ${project.id}`)
      chatOwners.set(chatId, project.id)
    }
  }
  const defaultProjectId = config.defaultProjectId?.trim() || projects[0]!.id
  if (!projectIds.has(defaultProjectId)) {
    throw new Error(`dsh-lark-bridge: unknown defaultProjectId ${defaultProjectId}`)
  }
  const unmappedAllowedChatIds = configuredAllowedChatIds.filter(chatId => !chatOwners.has(chatId))
  if (unmappedAllowedChatIds.length > 0 && (config.projects?.length ?? 0) > 0) {
    const defaultProject = projects.find(project => project.id === defaultProjectId)!
    defaultProject.chatIds = unique([...defaultProject.chatIds, ...unmappedAllowedChatIds])
  }
  const allowedChatIds = unique(projects.flatMap(project => project.chatIds))

  return {
    appId,
    appSecret,
    allowedOpenIds: unique([...(config.allowedOpenIds ?? []), ...parseCsv(env.DSH_LARK_ALLOWED_OPEN_IDS)]),
    allowedChatIds,
    allowAllUsers: Boolean(config.allowAllUsers) || parseBooleanEnv(env.DSH_LARK_ALLOW_ALL_USERS),
    allowAllGroups: Boolean(config.allowAllGroups) || parseBooleanEnv(env.DSH_LARK_ALLOW_ALL_GROUPS),
    requireMention: config.requireMention ?? true,
    groupSessionScope: config.groupSessionScope ?? 'thread',
    ...(provider === undefined || provider === '' ? {} : { provider }),
    ...(model === undefined || model === '' ? {} : { model }),
    cwd,
    workspaceRoot,
    inboundDir,
    nativeImageInput: config.nativeImageInput ?? false,
    progressCards: config.progressCards ?? true,
    progressUpdateMs: config.progressUpdateMs ?? 1000,
    maxInboundFileBytes: config.maxInboundFileBytes ?? 20 * 1024 * 1024,
    maxOutboundFileBytes: config.maxOutboundFileBytes ?? 30 * 1024 * 1024,
    interactiveTimeoutMs: config.interactiveTimeoutMs ?? 10 * 60 * 1000,
    provideUserQuestions: config.provideUserQuestions ?? true,
    enableApprovals: config.enableApprovals ?? true,
    cardBodyMaxChars: config.cardBodyMaxChars ?? 12000,
    cardPreset,
    defaultProjectId,
    projects,
  }
}

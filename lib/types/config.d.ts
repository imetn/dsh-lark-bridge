import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { CardPreset, GroupSessionScope, LarkBrand, ResolvedConfig } from './types.js';
/** Public Cordis configuration. Credentials should normally come from environment variables. */
export interface Config {
    appId?: string;
    appSecret?: string;
    appSecretRef?: string;
    brand?: LarkBrand;
    statePath?: string;
    allowedOpenIds?: string[];
    allowedChatIds?: string[];
    allowAllUsers?: boolean;
    allowAllGroups?: boolean;
    requireMention?: boolean;
    groupSessionScope?: GroupSessionScope;
    provider?: string;
    model?: string;
    cwd?: string;
    workspaceRoot?: string;
    inboundDir?: string;
    nativeImageInput?: boolean;
    progressCards?: boolean;
    progressUpdateMs?: number;
    maxInboundFileBytes?: number;
    maxOutboundFileBytes?: number;
    interactiveTimeoutMs?: number;
    provideUserQuestions?: boolean;
    enableApprovals?: boolean;
    cardBodyMaxChars?: number;
    cardPreset?: CardPreset;
    defaultProjectId?: string;
    projects?: ProjectConfig[];
}
/** A stable project binding. Group chats listed here are routed only to this project. */
export interface ProjectConfig {
    id: string;
    name?: string;
    chatIds?: string[];
    allowedOpenIds?: string[];
    provider?: string;
    model?: string;
    cwd?: string;
    workspaceRoot?: string;
    inboundDir?: string;
    cardPreset?: CardPreset;
}
export declare const ConfigSchema: Schema<Config>;
/** Resolve schema-normalized config with environment-only secrets and allowlists. */
export declare function resolveConfig(config: Config, env?: NodeJS.ProcessEnv): ResolvedConfig;
/** Resolve a credential reference through the Harness credential provider before booting the channel. */
export declare function resolveRuntimeConfig(ctx: Context, config: Config, env?: NodeJS.ProcessEnv): Promise<ResolvedConfig>;

/** DeepSeek Harness ↔ Lark/Feishu bidirectional control bridge. */
import type { Context } from '@deepseek-ai/cordis';
import { type Config as BridgeConfig } from './config.js';
export * from './bridge.js';
export * from './cards.js';
export * from './config.js';
export * from './identity.js';
export * from './security.js';
export type * from './types.js';
export declare const name = "dsh-lark-bridge";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<BridgeConfig>;
/** Connect after every injected Harness service is ready and drain cleanly on unload. */
export declare function apply(ctx: Context, config: BridgeConfig): Promise<void>;

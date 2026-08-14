/** DeepSeek Harness ↔ Lark/Feishu bidirectional control bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { LarkBridge } from './bridge.js'
import { ConfigSchema, resolveRuntimeConfig, type Config as BridgeConfig } from './config.js'

export * from './bridge.js'
export * from './cards.js'
export * from './config.js'
export * from './identity.js'
export * from './security.js'
export * from './state.js'
export type * from './types.js'

export const name = 'dsh-lark-bridge'
export const inject = ['agents', 'agentDefaultModel', 'credentials', 'tools', 'systemPrompt']
export const Config = ConfigSchema

/** Connect after every injected Harness service is ready and drain cleanly on unload. */
export async function apply(ctx: Context, config: BridgeConfig): Promise<void> {
  const bridge = new LarkBridge(ctx, await resolveRuntimeConfig(ctx, config))
  await ctx.effect(async () => {
    await bridge.start()
    return () => bridge.stop()
  }, 'dsh-lark-bridge.serve')
}

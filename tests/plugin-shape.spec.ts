import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LarkBridge } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import * as plugin from '../src/index.js'

describe('dsh-lark-bridge Loader contract', () => {
  it('declares the official Harness bundle and discovery metadata', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      keywords?: string[]
      peerDependencies?: Record<string, string>
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.keywords).toContain('dsh-plugin')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tool-ask-user']).toBe('^0.1.0-rc.6')
    expect(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).toContain('name: dsh-lark-bridge')
  })

  it('mounts the official ask-user tool in every Bridge-owned Agent scope', async () => {
    const config = resolveConfig({ cwd: process.cwd() }, {
      DSH_LARK_APP_ID: 'cli_test',
      DSH_LARK_APP_SECRET: 'secret-value',
    })
    let mountedName: string | undefined
    const bridge = new LarkBridge({} as Context, config, () => ({}) as never)
    const agentCtx = {
      plugin: async (mounted: { name?: string }) => { mountedName = mounted.name },
      systemPrompt: { section: () => undefined },
      tools: { register: () => undefined },
    } as unknown as Context
    const setupAgent = Reflect.get(LarkBridge.prototype, 'setupAgent') as (
      this: LarkBridge,
      ...args: unknown[]
    ) => Promise<void>

    await setupAgent.call(bridge, agentCtx, {
      chatId: 'oc_test',
      chatType: 'p2p',
      ownerOpenId: 'ou_test',
      replyInThread: false,
    }, config.projects[0])

    expect(mountedName).toBe('tool-ask-user')
  })

  it('preserves the namespace plugin through the real Loader export path', () => {
    expect('default' in plugin).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.name).toBe('dsh-lark-bridge')
    expect(unwrapped.inject).toEqual(['agents', 'agentDefaultModel', 'tools', 'systemPrompt'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})

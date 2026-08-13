import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as plugin from '../src/index.js'

describe('dsh-lark-bridge Loader contract', () => {
  it('declares the official Harness bundle and discovery metadata', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      keywords?: string[]
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.keywords).toContain('dsh-plugin')
    expect(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).toContain('name: dsh-lark-bridge')
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

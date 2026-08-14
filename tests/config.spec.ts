import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, resolveRuntimeConfig } from '../src/config.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-lark-config-'))
  roots.push(path)
  return path
}

describe('resolveConfig', () => {
  it('fails without app credentials', async () => {
    const cwd = await root()
    expect(() => resolveConfig({ cwd }, {})).toThrow('missing app id')
    expect(() => resolveConfig({ cwd }, { DSH_LARK_APP_ID: 'cli_test' })).toThrow('missing app secret')
  })

  it('is closed by default and merges environment allowlists', async () => {
    const cwd = await root()
    const config = resolveConfig({ cwd, allowedOpenIds: ['ou_config'] }, {
      DSH_LARK_APP_ID: 'cli_test',
      DSH_LARK_APP_SECRET: 'secret-value',
      DSH_LARK_ALLOWED_OPEN_IDS: 'ou_env, ou_config',
      DSH_LARK_ALLOWED_CHAT_IDS: 'oc_team',
    })
    expect(config.allowAllUsers).toBe(false)
    expect(config.allowAllGroups).toBe(false)
    expect(config.allowedOpenIds).toEqual(['ou_config', 'ou_env'])
    expect(config.allowedChatIds).toEqual(['oc_team'])
    expect(config.requireMention).toBe(true)
    expect(config.groupSessionScope).toBe('thread')
    expect(config.cardPreset).toBe('standard')
    expect(config.appSecretRef).toBe('DSH_LARK_APP_SECRET')
    expect(config.brand).toBe('feishu')
    expect(config.statePath).toContain('lark-bridge/cli_test.json')
    expect(config.projects).toMatchObject([{
      id: 'default',
      chatIds: ['oc_team'],
      cardPreset: 'standard',
    }])
  })

  it('resolves the App Secret through the official Harness credential seam', async () => {
    const cwd = await root()
    const ctx = {
      credentials: {
        resolve: async (ref: string) => ref === 'DSH_LARK_TEST_SECRET'
          ? { value: 'credential-value', source: 'file' }
          : undefined,
      },
    } as unknown as Context
    const config = await resolveRuntimeConfig(ctx, {
      appId: 'cli_test',
      appSecretRef: 'DSH_LARK_TEST_SECRET',
      cwd,
    }, {})
    expect(config.appSecret).toBe('credential-value')
    expect(config.appSecretRef).toBe('DSH_LARK_TEST_SECRET')
  })

  it('keeps cwd and inbound storage inside workspaceRoot', async () => {
    const workspaceRoot = await root()
    const outside = await root()
    expect(() => resolveConfig({ cwd: outside, workspaceRoot }, {
      DSH_LARK_APP_ID: 'cli_test',
      DSH_LARK_APP_SECRET: 'secret-value',
    })).toThrow('cwd must be inside workspaceRoot')
  })

  it('resolves isolated multi-project chat, model, path, access, and card settings', async () => {
    const workspaceRoot = await root()
    const ios = join(workspaceRoot, 'ios')
    const mac = join(workspaceRoot, 'mac')
    await Promise.all([mkdir(ios), mkdir(mac)])
    const config = resolveConfig({
      cwd: workspaceRoot,
      workspaceRoot,
      defaultProjectId: 'ios',
      projects: [
        { id: 'ios', name: 'iOS', chatIds: ['oc_ios'], allowedOpenIds: ['ou_ios'], cwd: ios, cardPreset: 'compact' },
        { id: 'mac', name: 'macOS', chatIds: ['oc_mac'], cwd: mac, model: 'deepseek-v4', cardPreset: 'developer' },
      ],
    }, {
      DSH_LARK_APP_ID: 'cli_test',
      DSH_LARK_APP_SECRET: 'secret-value',
    })
    expect(config.defaultProjectId).toBe('ios')
    expect(config.allowedChatIds).toEqual(['oc_ios', 'oc_mac'])
    expect(config.projects[0]).toMatchObject({
      id: 'ios', name: 'iOS', cwd: ios, workspaceRoot: ios, allowedOpenIds: ['ou_ios'], cardPreset: 'compact',
    })
    expect(config.projects[1]).toMatchObject({ id: 'mac', model: 'deepseek-v4', cardPreset: 'developer' })
  })

  it('rejects ambiguous or unsafe project bindings', async () => {
    const workspaceRoot = await root()
    const outside = await root()
    const env = { DSH_LARK_APP_ID: 'cli_test', DSH_LARK_APP_SECRET: 'secret-value' }
    expect(() => resolveConfig({
      cwd: workspaceRoot,
      projects: [{ id: 'one', chatIds: ['oc_same'] }, { id: 'two', chatIds: ['oc_same'] }],
    }, env)).toThrow('belongs to both')
    expect(() => resolveConfig({
      cwd: workspaceRoot,
      projects: [{ id: 'unsafe', cwd: outside, workspaceRoot }],
    }, env)).toThrow('cwd must be inside workspaceRoot')
    expect(() => resolveConfig({ cwd: workspaceRoot, projects: [{ id: '../bad' }] }, env)).toThrow('invalid project id')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridge } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import { BridgeStateStore } from '../src/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { multipleProjects?: boolean; staticChatId?: string } = {}): Promise<{
  bridge: LarkBridge
  state: BridgeStateStore
  sent: unknown[]
  updated: unknown[]
  message: (overrides: Partial<NormalizedMessage>) => NormalizedMessage
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-onboarding-'))
  roots.push(root)
  const statePath = join(root, 'state.json')
  const config = resolveConfig({
    appId: 'cli_test',
    appSecret: 'secret-value',
    statePath,
    cwd: root,
    projects: [
      { id: 'demo', name: 'Demo', cwd: root, workspaceRoot: root },
      ...(options.multipleProjects === true
        ? [{
            id: 'other',
            name: 'Other',
            cwd: root,
            workspaceRoot: root,
            ...(options.staticChatId === undefined ? {} : { chatIds: [options.staticChatId] }),
          }]
        : []),
    ],
    defaultProjectId: 'demo',
  }, {})
  const sent: unknown[] = []
  const updated: unknown[] = []
  const ctx = {
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as unknown as Context
  const bridge = new LarkBridge(ctx, config, () => ({
    send: async (chatId: string, input: unknown) => {
      sent.push({ chatId, input })
      return { messageId: 'om_sent' }
    },
    updateCard: async (messageId: string, card: object) => { updated.push({ messageId, card }) },
  }) as never)
  const message = (overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
    messageId: 'om_test',
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_owner',
    content: '',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...overrides,
  }) as NormalizedMessage
  return { bridge, state: new BridgeStateStore(statePath), sent, updated, message }
}

describe('first-run pairing and binding', () => {
  it('claims one owner without exposing arbitrary messages to an Agent', async () => {
    const { bridge, state, sent, message } = await fixture()
    await state.createPairing({ token: 'ABCDE-12345' })
    const onMessage = Reflect.get(LarkBridge.prototype, 'onMessage') as (
      this: LarkBridge,
      message: NormalizedMessage,
    ) => Promise<void>

    await onMessage.call(bridge, message({ senderId: 'ou_stranger', content: '运行任意命令' }))
    expect(sent).toHaveLength(0)
    await onMessage.call(bridge, message({ content: '/claim ABCDE-12345' }))
    await state.refresh()
    expect(state.snapshot().owners).toEqual(['ou_owner'])
    expect(JSON.stringify(sent.at(-1))).toContain('测试卡片按钮（可选）')
  })

  it('binds an unconfigured group and verifies the setup callback card', async () => {
    const { bridge, state, sent, updated, message } = await fixture()
    await state.createPairing({ token: 'ABCDE-12345' })
    await state.claim('ABCDE-12345', 'ou_owner')
    const onMessage = Reflect.get(LarkBridge.prototype, 'onMessage') as (
      this: LarkBridge,
      message: NormalizedMessage,
    ) => Promise<void>
    await onMessage.call(bridge, message({ chatId: 'oc_group', chatType: 'group', content: '/bind' }))
    await state.refresh()
    expect(state.projectForChat('oc_group')).toBe('demo')
    expect(JSON.stringify(sent.at(-1))).toContain('已把当前群绑定')

    const onCardAction = Reflect.get(LarkBridge.prototype, 'onCardAction') as (
      this: LarkBridge,
      event: CardActionEvent,
    ) => Promise<void>
    await onCardAction.call(bridge, {
      messageId: 'om_setup',
      chatId: 'oc_dm',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { bridge: 'dsh-lark-bridge', action: 'setup-verify' } },
    })
    await state.refresh()
    expect(state.snapshot().cardVerifiedAt).toBeTypeOf('number')
    expect(JSON.stringify(updated.at(-1))).toContain('全部就绪')
  })

  it('auto-binds the first mentioned group when exactly one project is available', async () => {
    const { bridge, state, sent, message } = await fixture()
    await state.addOwner('ou_owner')
    const onMessage = Reflect.get(LarkBridge.prototype, 'onMessage') as (
      this: LarkBridge,
      message: NormalizedMessage,
    ) => Promise<void>

    await onMessage.call(bridge, message({
      chatId: 'oc_first_group',
      chatType: 'group',
      mentionedBot: true,
    }))
    await state.refresh()
    expect(state.projectForChat('oc_first_group')).toBe('demo')
    expect(JSON.stringify(sent.at(-1))).toContain('已自动把当前群绑定')
  })

  it('replaces a stale group binding when its project no longer exists', async () => {
    const { bridge, state, message } = await fixture()
    await state.addOwner('ou_owner')
    await state.bindChat('oc_stale_group', 'removed-project')
    const onMessage = Reflect.get(LarkBridge.prototype, 'onMessage') as (
      this: LarkBridge,
      message: NormalizedMessage,
    ) => Promise<void>

    await onMessage.call(bridge, message({
      chatId: 'oc_stale_group',
      chatType: 'group',
      mentionedBot: true,
    }))
    await state.refresh()
    expect(state.projectForChat('oc_stale_group')).toBe('demo')
  })

  it('gives static chatIds precedence over a conflicting dynamic binding', async () => {
    const { bridge, state, message } = await fixture({ multipleProjects: true, staticChatId: 'oc_static_group' })
    await state.addOwner('ou_owner')
    await state.bindChat('oc_static_group', 'demo')
    const bridgeState = Reflect.get(bridge, 'state') as BridgeStateStore
    await bridgeState.refresh()
    const projectForMessage = Reflect.get(LarkBridge.prototype, 'projectForMessage') as (
      this: LarkBridge,
      input: NormalizedMessage,
    ) => { id: string }

    const project = projectForMessage.call(bridge, message({
      chatId: 'oc_static_group',
      chatType: 'group',
    }))
    expect(project.id).toBe('other')
  })

  it('asks for an explicit project instead of guessing when several are available', async () => {
    const { bridge, state, sent, message } = await fixture({ multipleProjects: true })
    await state.addOwner('ou_owner')
    const onMessage = Reflect.get(LarkBridge.prototype, 'onMessage') as (
      this: LarkBridge,
      message: NormalizedMessage,
    ) => Promise<void>

    await onMessage.call(bridge, message({
      chatId: 'oc_multi_group',
      chatType: 'group',
      mentionedBot: true,
    }))
    await state.refresh()
    expect(state.projectForChat('oc_multi_group')).toBeUndefined()
    expect(JSON.stringify(sent.at(-1))).toContain('/bind <project-id>')
  })

  it('sends one proactive welcome to an owner created by one-click setup', async () => {
    const { bridge, state, sent } = await fixture()
    await state.addOwner('ou_owner', { welcome: true })
    const sendPendingWelcomes = Reflect.get(LarkBridge.prototype, 'sendPendingWelcomes') as (
      this: LarkBridge,
    ) => Promise<void>

    await sendPendingWelcomes.call(bridge)
    await state.refresh()
    expect(sent.at(-1)).toMatchObject({ chatId: 'ou_owner' })
    expect(JSON.stringify(sent.at(-1))).toContain('Lark Bridge 已就绪')
    expect(state.snapshot().pendingWelcomeOwners).toEqual([])
  })
})

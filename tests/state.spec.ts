import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeStateStore, hashPairingToken } from '../src/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function stateStore(): Promise<{ root: string; path: string; store: BridgeStateStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-state-'))
  roots.push(root)
  const path = join(root, 'state.json')
  return { root, path, store: new BridgeStateStore(path) }
}

describe('BridgeStateStore', () => {
  it('stores only a hash and consumes a valid one-time pairing token', async () => {
    const { path, store } = await stateStore()
    const pairing = await store.createPairing({ token: 'ABCDE-12345', now: 1_000, ttlMs: 10_000 })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(pairing.token)
    expect(text).toContain(hashPairingToken(pairing.token))

    await expect(store.claim('wrong', 'ou_owner', 2_000)).resolves.toEqual({ status: 'invalid', attemptsRemaining: 7 })
    await expect(store.claim(pairing.token.toLowerCase(), 'ou_owner', 2_000)).resolves.toEqual({ status: 'claimed' })
    expect(store.snapshot().owners).toEqual(['ou_owner'])
    expect(store.snapshot().pairing).toBeUndefined()
    await expect(store.claim(pairing.token, 'ou_owner', 2_000)).resolves.toEqual({ status: 'already-owner' })
  })

  it('expires pairing and persists chat bindings and callback verification', async () => {
    const { path, store } = await stateStore()
    await store.createPairing({ token: 'ABCDE-12345', now: 1_000, ttlMs: 10 })
    await expect(store.claim('ABCDE-12345', 'ou_late', 1_011)).resolves.toEqual({ status: 'expired' })
    await store.bindChat('oc_group', 'web')
    await store.markCardVerified(9_000)

    const reloaded = new BridgeStateStore(path)
    await reloaded.refresh()
    expect(reloaded.projectForChat('oc_group')).toBe('web')
    expect(reloaded.snapshot().cardVerifiedAt).toBe(9_000)
    await expect(reloaded.unbindChat('oc_group')).resolves.toBe(true)
    await expect(reloaded.unbindChat('oc_group')).resolves.toBe(false)
  })

  it('queues and consumes a proactive welcome for an automatically registered owner', async () => {
    const { path, store } = await stateStore()
    await store.createPairing({ token: 'ABCDE-12345' })
    await expect(store.addOwner('ou_owner', { welcome: true })).resolves.toBe(true)
    expect(store.snapshot().pairing).toBeUndefined()
    expect(store.snapshot().pendingWelcomeOwners).toEqual(['ou_owner'])

    await store.markWelcomeSent('ou_owner')
    const reloaded = new BridgeStateStore(path)
    await reloaded.refresh()
    expect(reloaded.snapshot().owners).toEqual(['ou_owner'])
    expect(reloaded.snapshot().pendingWelcomeOwners).toEqual([])
  })

  it('rejects a state file readable by other users on POSIX', async () => {
    if (process.platform === 'win32') return
    const { path, store } = await stateStore()
    await writeFile(path, '{"version":1,"owners":[],"chatBindings":{}}\n', { mode: 0o644 })
    await chmod(path, 0o644)
    await expect(store.refresh()).rejects.toThrow('owner-only')
  })
})

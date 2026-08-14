import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000
export const DEFAULT_PAIRING_ATTEMPTS = 8

export interface PendingPairing {
  tokenHash: string
  expiresAt: number
  attemptsRemaining: number
}

export interface BridgeState {
  version: 1
  owners: string[]
  chatBindings: Record<string, string>
  pendingWelcomeOwners: string[]
  pairing?: PendingPairing
  cardVerifiedAt?: number
}

export type ClaimResult =
  | { status: 'claimed' }
  | { status: 'already-owner' }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'expired' | 'unavailable' }

function emptyState(): BridgeState {
  return { version: 1, owners: [], chatBindings: {}, pendingWelcomeOwners: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`dsh-lark-bridge: invalid ${field} in state file`)
  }
  return [...new Set(value.map(item => item.trim()))]
}

function parseState(text: string): BridgeState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-lark-bridge: invalid state JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw) || raw.version !== 1) throw new Error('dsh-lark-bridge: unsupported state file version')
  const owners = uniqueStrings(raw.owners, 'owners')
  const pendingWelcomeOwners = uniqueStrings(raw.pendingWelcomeOwners ?? [], 'pendingWelcomeOwners')
  if (!isRecord(raw.chatBindings)) throw new Error('dsh-lark-bridge: invalid chatBindings in state file')
  const chatBindings: Record<string, string> = {}
  for (const [chatId, projectId] of Object.entries(raw.chatBindings)) {
    if (chatId.trim() === '' || typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('dsh-lark-bridge: invalid chat binding in state file')
    }
    chatBindings[chatId] = projectId.trim()
  }
  let pairing: PendingPairing | undefined
  if (raw.pairing !== undefined) {
    const rawPairing = raw.pairing
    if (!isRecord(rawPairing)
      || typeof rawPairing.tokenHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(rawPairing.tokenHash)
      || typeof rawPairing.expiresAt !== 'number'
      || !Number.isFinite(rawPairing.expiresAt)
      || typeof rawPairing.attemptsRemaining !== 'number'
      || !Number.isInteger(rawPairing.attemptsRemaining)
      || rawPairing.attemptsRemaining < 0) {
      throw new Error('dsh-lark-bridge: invalid pairing record in state file')
    }
    pairing = {
      tokenHash: rawPairing.tokenHash,
      expiresAt: rawPairing.expiresAt,
      attemptsRemaining: rawPairing.attemptsRemaining,
    }
  }
  const cardVerifiedAt = typeof raw.cardVerifiedAt === 'number' && Number.isFinite(raw.cardVerifiedAt)
    ? raw.cardVerifiedAt
    : undefined
  return {
    version: 1,
    owners,
    chatBindings,
    pendingWelcomeOwners: pendingWelcomeOwners.filter(openId => owners.includes(openId)),
    ...(pairing === undefined ? {} : { pairing }),
    ...(cardVerifiedAt === undefined ? {} : { cardVerifiedAt }),
  }
}

function normalizedToken(token: string): string {
  return token.replace(/[\s-]/gu, '').toUpperCase()
}

/** Hash one setup token before it reaches durable state. */
export function hashPairingToken(token: string): string {
  return createHash('sha256').update(normalizedToken(token), 'utf8').digest('hex')
}

/** Generate a copy-friendly 40-bit one-time setup token. */
export function generatePairingToken(): string {
  const raw = randomBytes(5).toString('hex').toUpperCase()
  return `${raw.slice(0, 5)}-${raw.slice(5)}`
}

function matchesToken(input: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPairingToken(input), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Owner-only, atomic persistent state for pairing and chat-to-project bindings. */
export class BridgeStateStore {
  private state: BridgeState = emptyState()
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(readonly path: string) {}

  snapshot(): BridgeState {
    return structuredClone(this.state)
  }

  async refresh(): Promise<BridgeState> {
    try {
      const info = await stat(this.path)
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        throw new Error(`dsh-lark-bridge: state file must be owner-only (run chmod 600 ${this.path})`)
      }
      this.state = parseState(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = emptyState()
    }
    return this.snapshot()
  }

  isOwner(openId: string): boolean {
    return this.state.owners.includes(openId)
  }

  projectForChat(chatId: string): string | undefined {
    return this.state.chatBindings[chatId]
  }

  private async write(next: BridgeState): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    const temporary = join(directory, `.${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      if (process.platform !== 'win32') await chmod(temporary, 0o600)
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    this.state = next
  }

  private mutate<T>(operation: (current: BridgeState) => Promise<{ next: BridgeState; result: T }> | { next: BridgeState; result: T }): Promise<T> {
    const run = this.mutation.then(async () => {
      const current = await this.refresh()
      const { next, result } = await operation(current)
      await this.write(next)
      return result
    })
    this.mutation = run.then(() => undefined, () => undefined)
    return run
  }

  async createPairing(options: { token?: string; now?: number; ttlMs?: number; attempts?: number } = {}): Promise<{
    token: string
    expiresAt: number
  }> {
    const token = options.token ?? generatePairingToken()
    const now = options.now ?? Date.now()
    const expiresAt = now + (options.ttlMs ?? DEFAULT_PAIRING_TTL_MS)
    const attemptsRemaining = options.attempts ?? DEFAULT_PAIRING_ATTEMPTS
    if (attemptsRemaining < 1 || !Number.isInteger(attemptsRemaining)) throw new Error('pairing attempts must be a positive integer')
    await this.mutate(current => ({
      next: {
        ...current,
        pairing: { tokenHash: hashPairingToken(token), expiresAt, attemptsRemaining },
      },
      result: undefined,
    }))
    return { token, expiresAt }
  }

  async addOwner(openId: string, options: { welcome?: boolean } = {}): Promise<boolean> {
    const normalized = openId.trim()
    if (!/^ou_[A-Za-z0-9_-]+$/u.test(normalized)) throw new Error('owner open id must start with ou_')
    return this.mutate(current => {
      const added = !current.owners.includes(normalized)
      const owners = added ? [...current.owners, normalized] : current.owners
      const pendingWelcomeOwners = options.welcome === true && !current.pendingWelcomeOwners.includes(normalized)
        ? [...current.pendingWelcomeOwners, normalized]
        : current.pendingWelcomeOwners
      const { pairing: _pairing, ...rest } = current
      return {
        next: { ...rest, owners, pendingWelcomeOwners },
        result: added,
      }
    })
  }

  async markWelcomeSent(openId: string): Promise<void> {
    await this.mutate(current => ({
      next: {
        ...current,
        pendingWelcomeOwners: current.pendingWelcomeOwners.filter(owner => owner !== openId),
      },
      result: undefined,
    }))
  }

  async claim(token: string, openId: string, now = Date.now()): Promise<ClaimResult> {
    return this.mutate<ClaimResult>(current => {
      if (current.owners.includes(openId)) return { next: current, result: { status: 'already-owner' } as const }
      const pairing = current.pairing
      if (pairing === undefined) return { next: current, result: { status: 'unavailable' } as const }
      if (now > pairing.expiresAt || pairing.attemptsRemaining === 0) {
        const { pairing: _expired, ...next } = current
        return { next, result: { status: 'expired' } as const }
      }
      if (!matchesToken(token, pairing.tokenHash)) {
        const attemptsRemaining = pairing.attemptsRemaining - 1
        const next: BridgeState = attemptsRemaining === 0
          ? (({ pairing: _invalid, ...rest }) => rest)(current)
          : { ...current, pairing: { ...pairing, attemptsRemaining } }
        return { next, result: { status: 'invalid', attemptsRemaining } as const }
      }
      const { pairing: _claimed, ...rest } = current
      return {
        next: { ...rest, owners: [...current.owners, openId] },
        result: { status: 'claimed' } as const,
      }
    })
  }

  async bindChat(chatId: string, projectId: string): Promise<void> {
    await this.mutate(current => ({
      next: { ...current, chatBindings: { ...current.chatBindings, [chatId]: projectId } },
      result: undefined,
    }))
  }

  async unbindChat(chatId: string): Promise<boolean> {
    return this.mutate(current => {
      if (current.chatBindings[chatId] === undefined) return { next: current, result: false }
      const chatBindings = { ...current.chatBindings }
      delete chatBindings[chatId]
      return { next: { ...current, chatBindings }, result: true }
    })
  }

  async markCardVerified(now = Date.now()): Promise<void> {
    await this.mutate(current => ({ next: { ...current, cardVerifiedAt: now }, result: undefined }))
  }
}

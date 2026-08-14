import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { registerApp } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

describe('dsh-lark setup CLI', () => {
  it('rejects misspelled flags and supports subcommand help', async () => {
    await expect(main(['setup', '--no-strat'])).rejects.toThrow('无法识别的参数：--no-strat')

    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write)
    await main(['setup', '--help'])
    expect(stdout).toContain('DeepSeek Harness Lark Bridge 接入向导')
  })

  it('creates a new app through the official create-only flow and binds the authorizing owner', async () => {
    const dshHome = await root('dsh-lark-cli-home-')
    const project = await root('dsh-lark-cli-project-')
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write)
    const fakeRegister = vi.fn(async (options: Parameters<typeof registerApp>[0]) => {
      options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device/test', expireIn: 600 })
      return {
        client_id: 'cli_created123',
        client_secret: 'created-secret',
        user_info: { open_id: 'ou_creator', tenant_brand: 'feishu' as const },
      }
    })
    const fakeOpen = vi.fn(async () => undefined)

    await main([
      'setup', '--dsh-home', dshHome, '--project', project, '--brand', 'larkoffice',
      '--no-install', '--no-start', '--no-open', '--no-verify', '--json',
    ], { registerApp: fakeRegister as typeof registerApp, openUrl: fakeOpen })

    const envelope = JSON.parse(stdout) as {
      ok: boolean
      data: { claimCommand?: string; statePath: string; botUrl: string; createdApp: boolean; ownerBound: boolean }
    }
    expect(envelope.data).toMatchObject({ createdApp: true, ownerBound: true })
    expect(envelope.data.claimCommand).toBeUndefined()
    expect(envelope.data.botUrl).toContain('applink.larkoffice.com')
    expect(stderr).toContain('authorization_required')
    expect(stderr).not.toContain('created-secret')
    expect(fakeOpen).not.toHaveBeenCalled()
    expect(fakeRegister).toHaveBeenCalledOnce()
    expect(fakeRegister.mock.calls[0]?.[0]).toMatchObject({ createOnly: true })
    expect(fakeRegister.mock.calls[0]?.[0]).not.toHaveProperty('appId')
    const state = JSON.parse(await readFile(envelope.data.statePath, 'utf8')) as {
      owners: string[]
      pendingWelcomeOwners: string[]
    }
    expect(state.owners).toEqual(['ou_creator'])
    expect(state.pendingWelcomeOwners).toEqual(['ou_creator'])
    expect(await readFile(join(dshHome, '.credentials.yaml'), 'utf8')).toContain('created-secret')
  })

  it('creates a minimal profile, credential reference, and hashed pairing without leaking the secret', async () => {
    const dshHome = await root('dsh-lark-cli-home-')
    const project = await root('dsh-lark-cli-project-')
    vi.stubEnv('DSH_LARK_APP_SECRET', 'super-secret-value')
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write)
    const existingAppRegister = vi.fn()

    await main([
      'setup', '--app-id', 'cli_test123', '--dsh-home', dshHome, '--project', project,
      '--no-install', '--no-start', '--no-open', '--no-verify', '--json',
    ], {
      registerApp: existingAppRegister as unknown as typeof registerApp,
      openUrl: async () => undefined,
    })

    const envelope = JSON.parse(stdout) as { ok: boolean; data: { claimCommand: string; statePath: string } }
    expect(envelope.ok).toBe(true)
    expect(existingAppRegister).not.toHaveBeenCalled()
    expect(stdout).not.toContain('super-secret-value')
    expect(envelope.data.claimCommand).toMatch(/^\/claim [A-F0-9]{5}-[A-F0-9]{5}$/u)

    const patch = parse(await readFile(join(dshHome, 'profiles', 'lark', 'cordis.patch.yml'), 'utf8')) as Array<{
      id: string
      config: Record<string, unknown>
    }>
    expect(patch[0]?.id).toBe('dsh-lark-bridge')
    expect(patch[0]?.config).toMatchObject({
      appId: 'cli_test123',
      appSecretRef: 'DSH_LARK_APP_SECRET',
      brand: 'feishu',
    })
    expect(JSON.stringify(patch)).not.toContain('super-secret-value')
    expect(await readFile(join(dshHome, '.credentials.yaml'), 'utf8')).toContain('super-secret-value')
    const state = await readFile(envelope.data.statePath, 'utf8')
    expect(state).not.toContain(envelope.data.claimCommand.split(' ')[1]!)
  })

  it('is idempotent and refuses to replace another app without force', async () => {
    const dshHome = await root('dsh-lark-cli-home-')
    const project = await root('dsh-lark-cli-project-')
    vi.stubEnv('DSH_LARK_APP_SECRET', 'same-secret')
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write)
    const common = ['--dsh-home', dshHome, '--project', project, '--no-install', '--no-start', '--no-open', '--no-verify', '--json']
    await main(['setup', '--app-id', 'cli_first', ...common])
    await main(['setup', '--app-id', 'cli_first', ...common])
    await expect(main(['setup', '--app-id', 'cli_second', ...common])).rejects.toThrow('另一个 App ID')
  })

  it('refuses a conflicting environment secret unless replacement is explicit', async () => {
    const dshHome = await root('dsh-lark-cli-home-')
    const project = await root('dsh-lark-cli-project-')
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write)
    const common = [
      'setup', '--app-id', 'cli_same', '--dsh-home', dshHome, '--project', project,
      '--no-install', '--no-start', '--no-open', '--no-verify', '--json',
    ]
    vi.stubEnv('DSH_LARK_APP_SECRET', 'first-secret')
    await main(common)

    vi.stubEnv('DSH_LARK_APP_SECRET', 'replacement-secret')
    await expect(main(common)).rejects.toThrow('已存在且不同')
    await main([...common, '--force'])
    expect(await readFile(join(dshHome, '.credentials.yaml'), 'utf8')).toContain('replacement-secret')
  })

  it('migrates a legacy plaintext Profile secret into owner-only credential storage', async () => {
    const dshHome = await root('dsh-lark-cli-home-')
    const project = await root('dsh-lark-cli-project-')
    const profileDir = join(dshHome, 'profiles', 'lark')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), [
      '- id: dsh-lark-bridge',
      '  config:',
      '    appId: cli_legacy',
      '    appSecret: legacy-plaintext-secret',
      '',
    ].join('\n'))
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write)

    await main([
      'setup', '--dsh-home', dshHome, '--project', project,
      '--no-install', '--no-start', '--no-open', '--no-verify', '--json',
    ])

    const profile = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(profile).not.toContain('appSecret:')
    expect(profile).toContain('appSecretRef: DSH_LARK_APP_SECRET')
    expect(await readFile(join(dshHome, '.credentials.yaml'), 'utf8')).toContain('legacy-plaintext-secret')
  })
})

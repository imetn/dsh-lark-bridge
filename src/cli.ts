import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { registerApp } from '@larksuiteoapi/node-sdk'
import { Document, isMap, isSeq, parseDocument } from 'yaml'
import { BridgeStateStore } from './state.js'

const PACKAGE_NAME = 'dsh-lark-bridge'
const DEFAULT_PROFILE = 'lark'
const DEFAULT_PLUGIN_SOURCE = 'github:imetn/dsh-lark-bridge'
const FEISHU_SETUP_URL = 'https://open.feishu.cn/document/develop-a-card-interactive-bot/introduction?lang=zh-CN'
const LARK_SETUP_URL = 'https://open.larksuite.com/document/develop-a-card-interactive-bot/introduction'

type Brand = 'feishu' | 'lark' | 'larkoffice'

interface CliRuntime {
  registerApp: typeof registerApp
  openUrl: (url: string) => Promise<void>
}

interface ParsedArgs {
  command: 'setup' | 'pair' | 'doctor' | 'help'
  values: Map<string, string>
  flags: Set<string>
}

interface DshRunner {
  executable: string
  prefix: string[]
  display: string
  cwd?: string
}

interface ProfileConfig {
  appId?: string
  appSecret?: string
  appSecretRef?: string
  brand?: Brand
  statePath?: string
  defaultProjectId?: string
  projects?: Array<{ id?: string; name?: string; cwd?: string; workspaceRoot?: string }>
  [key: string]: unknown
}

interface SetupResult {
  profile: string
  project: string
  appId: string
  brand: Brand
  statePath: string
  botUrl: string
  claimCommand?: string
  pairingExpiresAt?: number
  createdApp: boolean
  ownerBound: boolean
  installed: boolean
  started: boolean
}

function usage(): string {
  return `DeepSeek Harness Lark Bridge 接入向导

用法：
  dsh-lark setup [选项]   创建或接入应用，安装、配置并启动 Bridge
  dsh-lark pair [选项]    生成新的十分钟一次性配对码
  dsh-lark doctor [选项]  检查本地配置与飞书应用凭据

常用选项：
  --profile <name>          Harness Profile，默认 lark
  --project <path>          默认 Project 目录，默认当前目录
  --brand <feishu|lark|larkoffice>
                            平台；字节租户使用 larkoffice
  --app-id <cli_xxx>        已有应用的 App ID
  --manual                  手动创建新应用；已有 App ID 从不被远程修改
  --app-secret-stdin        从 stdin 读取 App Secret，避免出现在进程参数中
  --dsh-home <path>         覆盖 Harness 主目录
  --plugin-source <spec>    插件来源，默认 ${DEFAULT_PLUGIN_SOURCE}
  --dsh-bin <path>          显式指定 dsh 可执行文件
  --no-open                 不自动打开官方授权页和机器人会话
  --no-start                配置完成后不启动 Bridge
  --no-install              跳过 dsh plugin add（仅用于已有安装）
  --no-verify               跳过应用凭据联网验证
  --force                   明确覆盖已有但不同的 App 配置
  --json                    输出机器可读结果

安全说明：不支持 --app-secret；请使用交互式隐藏输入或 --app-secret-stdin。`
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: ParsedArgs['command'] = 'help'
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const input = [...argv]
  const first = input[0]
  if (first === 'setup' || first === 'pair' || first === 'doctor' || first === 'help') {
    command = first
    input.shift()
  } else if (first === undefined || first === '--help' || first === '-h') {
    return { command: 'help', values, flags }
  } else {
    throw new Error(`未知命令：${first}`)
  }
  if (input.includes('--help') || input.includes('-h')) {
    return { command: 'help', values, flags }
  }
  const valueFlags = new Set([
    'profile', 'project', 'brand', 'app-id', 'dsh-home', 'plugin-source', 'dsh-bin',
  ])
  const booleanFlags = new Set([
    'manual', 'app-secret-stdin', 'no-open', 'no-start', 'no-install', 'no-verify', 'force', 'json',
  ])
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]!
    if (!item.startsWith('--')) throw new Error(`无法识别的参数：${item}`)
    const [rawName, inline] = item.slice(2).split('=', 2)
    if (rawName === 'app-secret') {
      throw new Error('出于安全考虑不支持 --app-secret；请使用隐藏输入或 --app-secret-stdin')
    }
    if (valueFlags.has(rawName)) {
      const value = inline ?? input[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`--${rawName} 需要一个值`)
      values.set(rawName, value)
    } else if (booleanFlags.has(rawName)) {
      if (inline !== undefined) throw new Error(`--${rawName} 不接受值`)
      flags.add(rawName)
    } else {
      throw new Error(`无法识别的参数：--${rawName}`)
    }
  }
  return { command, values, flags }
}

function dshHomeFrom(args: ParsedArgs): string {
  return resolve(args.values.get('dsh-home') ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
}

function validateProfile(value: string): string {
  const profile = value.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(profile)) throw new Error(`无效的 Profile 名称：${value}`)
  return profile
}

function validateBrand(value: string): Brand {
  if (value !== 'feishu' && value !== 'lark' && value !== 'larkoffice') {
    throw new Error('--brand 必须是 feishu、lark 或 larkoffice')
  }
  return value
}

function validateAppId(value: string): string {
  const appId = value.trim()
  if (!/^cli_[A-Za-z0-9]+$/u.test(appId)) throw new Error('App ID 格式无效，应以 cli_ 开头')
  return appId
}

function projectIdFrom(path: string): string {
  const slug = basename(path).toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  return /^[a-z0-9]/u.test(slug) ? slug : 'default'
}

function credentialRefFor(profile: string): string {
  if (profile === DEFAULT_PROFILE) return 'DSH_LARK_APP_SECRET'
  return `DSH_LARK_${profile.replace(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_APP_SECRET`
}

function setupUrl(brand: Brand): string {
  return brand === 'lark' ? LARK_SETUP_URL : FEISHU_SETUP_URL
}

function botUrl(brand: Brand, appId: string): string {
  const host = brand === 'lark'
    ? 'applink.larksuite.com'
    : brand === 'larkoffice'
      ? 'applink.larkoffice.com'
      : 'applink.feishu.cn'
  return `https://${host}/client/bot/open?appId=${encodeURIComponent(appId)}`
}

function info(text: string, json: boolean): void {
  if (!json) process.stdout.write(`${text}\n`)
}

async function ask(label: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${label} 需要交互式终端或对应命令行选项`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultValue === undefined ? '' : `（默认 ${defaultValue}）`
    const answer = (await rl.question(`${label}${suffix}：`)).trim()
    return answer || defaultValue || ''
  } finally {
    rl.close()
  }
}

async function askSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error(`${label} 需要交互式终端；自动化场景请使用 --app-secret-stdin`)
  }
  return new Promise<string>((resolveSecret, reject) => {
    let value = ''
    const input = process.stdin
    const cleanup = () => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
    }
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk)
      for (const character of text) {
        if (character === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('用户取消'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolveSecret(value.trim())
          return
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (character >= ' ') {
          value += character
          process.stdout.write('•')
        }
      }
    }
    process.stdout.write(`${label}：`)
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function readStdinSecret(): Promise<string> {
  let value = ''
  for await (const chunk of process.stdin) value += String(chunk)
  const secret = value.trim()
  if (secret === '') throw new Error('stdin 中没有 App Secret')
  return secret
}

async function openUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? { executable: 'open', args: [url] }
    : process.platform === 'win32'
      ? { executable: 'cmd', args: ['/c', 'start', '', url] }
      : { executable: 'xdg-open', args: [url] }
  const child = spawn(command.executable, command.args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

const DEFAULT_RUNTIME: CliRuntime = { registerApp, openUrl }

async function createApp(args: ParsedArgs, json: boolean, runtime: CliRuntime): Promise<{
  appId: string
  secret: string
  ownerOpenId?: string
  tenantBrand?: 'feishu' | 'lark'
}> {
  info('1/5 正在生成官方一键创建链接…', json)
  try {
    const result = await runtime.registerApp({
      source: PACKAGE_NAME,
      createOnly: true,
      appPreset: {
        name: 'DeepSeek Harness Controller',
        desc: '在飞书或 Lark 中安全地控制 DeepSeek Harness Agent',
      },
      addons: {
        preset: false,
        scopes: {
          tenant: [
            'im:message.p2p_msg:readonly',
            'im:message.group_at_msg:readonly',
            'im:message:send_as_bot',
            'im:message:readonly',
            'im:message.reactions:read',
            'im:resource',
          ],
        },
        events: { items: { tenant: ['im.message.receive_v1', 'im.message.reaction.created_v1'] } },
        callbacks: { items: ['card.action.trigger'] },
      },
      onQRCodeReady: authorization => {
        if (json) {
          process.stderr.write(`${JSON.stringify({
            event: 'authorization_required',
            url: authorization.url,
            expiresIn: authorization.expireIn,
          })}\n`)
        } else {
          process.stdout.write(`请在浏览器确认创建新应用（${authorization.expireIn} 秒内有效）：\n${authorization.url}\n`)
        }
        if (!args.flags.has('no-open')) {
          void runtime.openUrl(authorization.url).catch(() => undefined)
        }
      },
    })
    return {
      appId: validateAppId(result.client_id),
      secret: result.client_secret,
      ...(result.user_info?.open_id === undefined ? {} : { ownerOpenId: result.user_info.open_id }),
      ...(result.user_info?.tenant_brand === undefined ? {} : { tenantBrand: result.user_info.tenant_brand }),
    }
  } catch (error) {
    const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
    const reason = typeof record.description === 'string'
      ? record.description
      : error instanceof Error
        ? error.message
        : String(error)
    throw new Error(`一键创建应用未完成：${reason}。可添加 --manual 改用开发者后台创建`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readYamlDocument(path: string, fallback: unknown): Promise<Document.Parsed> {
  try {
    const document = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true })
    if (document.errors.length > 0) throw document.errors[0]
    return document
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return new Document(fallback) as Document.Parsed
  }
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx', mode })
    if (process.platform !== 'win32') await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function readCredential(path: string, ref: string): Promise<string | undefined> {
  if (!(await pathExists(path))) return undefined
  const file = await stat(path)
  if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) {
    throw new Error(`凭据文件权限过宽，请先执行 chmod 600 ${path}`)
  }
  const document = await readYamlDocument(path, {})
  if (!isMap(document.contents)) throw new Error('Harness 凭据文件必须是 YAML 映射')
  const value = document.get(ref)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`凭据 ${ref} 必须是非空字符串`)
  return value
}

async function writeCredential(path: string, ref: string, secret: string): Promise<void> {
  const document = await readYamlDocument(path, {})
  if (!isMap(document.contents)) throw new Error('Harness 凭据文件必须是 YAML 映射')
  document.set(ref, secret)
  await atomicWrite(path, document.toString({ lineWidth: 0 }), 0o600)
}

async function readProfileConfig(path: string): Promise<{ document: Document.Parsed; index?: number; config: ProfileConfig }> {
  const document = await readYamlDocument(path, [])
  if (!isSeq(document.contents)) throw new Error('Profile cordis.patch.yml 必须是 YAML 数组')
  const rows = document.toJS() as unknown[]
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    if (record.id !== 'dsh-lark-bridge') continue
    const config = record.config
    if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
      throw new Error('dsh-lark-bridge Profile 配置必须是对象')
    }
    return { document, index, config: (config ?? {}) as ProfileConfig }
  }
  return { document, config: {} }
}

async function writeProfileConfig(options: {
  path: string
  appId: string
  appSecretRef: string
  brand: Brand
  statePath: string
  projectPath: string
  force: boolean
}): Promise<{ projectId: string }> {
  const current = await readProfileConfig(options.path)
  const existingAppId = typeof current.config.appId === 'string' ? current.config.appId : undefined
  if (existingAppId !== undefined && existingAppId !== '' && existingAppId !== options.appId && !options.force) {
    throw new Error(`Profile 已绑定另一个 App ID；如确需替换，请重新运行并添加 --force`)
  }
  const projectId = current.config.defaultProjectId
    ?? current.config.projects?.find(project => typeof project.id === 'string')?.id
    ?? projectIdFrom(options.projectPath)
  const minimalProject = {
    id: projectId,
    name: basename(options.projectPath) || projectId,
    cwd: options.projectPath,
    workspaceRoot: options.projectPath,
  }
  const { appSecret: _legacyAppSecret, ...preservedConfig } = current.config
  const nextConfig: ProfileConfig = {
    ...preservedConfig,
    appId: options.appId,
    appSecretRef: options.appSecretRef,
    brand: options.brand,
    statePath: options.statePath,
    defaultProjectId: projectId,
    projects: current.config.projects?.length ? current.config.projects : [minimalProject],
  }
  if (current.index === undefined) {
    current.document.add({ id: 'dsh-lark-bridge', config: nextConfig })
  } else {
    current.document.deleteIn([current.index, 'config', 'appSecret'])
    for (const key of ['appId', 'appSecretRef', 'brand', 'statePath'] as const) {
      current.document.setIn([current.index, 'config', key], nextConfig[key])
    }
    if (current.config.defaultProjectId === undefined) {
      current.document.setIn([current.index, 'config', 'defaultProjectId'], projectId)
    }
    if (!current.config.projects?.length) {
      current.document.setIn([current.index, 'config', 'projects'], [minimalProject])
    }
  }
  await atomicWrite(options.path, current.document.toString({ lineWidth: 0 }), 0o600)
  return { projectId }
}

async function profileConfiguration(dshHome: string, profile: string): Promise<{
  patchPath: string
  profileDir: string
  config: ProfileConfig
}> {
  const profileDir = join(dshHome, 'profiles', profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const { config } = await readProfileConfig(patchPath)
  return { patchPath, profileDir, config }
}

async function validateProject(path: string): Promise<string> {
  const absolute = resolve(path)
  const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`Project 目录不存在：${absolute}`)
    throw error
  })
  if (!info.isDirectory()) throw new Error(`Project 路径不是目录：${absolute}`)
  return absolute
}

async function validateCredentials(appId: string, secret: string, brand: Brand): Promise<void> {
  const domain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: secret }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json() as { code?: number; msg?: string }
  if (!response.ok || body.code !== 0) throw new Error(`飞书应用凭据验证失败：${body.msg ?? `HTTP ${response.status}`}`)
}

async function commandAvailable(executable: string): Promise<boolean> {
  return new Promise(resolveAvailable => {
    const child = spawn(executable, ['--version'], { stdio: 'ignore' })
    child.once('error', () => resolveAvailable(false))
    child.once('exit', code => resolveAvailable(code === 0))
  })
}

async function locateHarnessSource(start: string): Promise<string | undefined> {
  let current = resolve(start)
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [join(current, 'deepseek-harness'), current]) {
      if (await pathExists(join(candidate, 'apps', 'cli', 'src', 'bin.ts'))) return candidate
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

async function resolveDshRunner(args: ParsedArgs): Promise<DshRunner> {
  const explicit = args.values.get('dsh-bin')
  if (explicit !== undefined) return { executable: resolve(explicit), prefix: [], display: explicit }
  if (await commandAvailable('dsh')) return { executable: 'dsh', prefix: [], display: 'dsh' }
  const source = await locateHarnessSource(process.cwd())
  if (source !== undefined && await commandAvailable('pnpm')) {
    return { executable: 'pnpm', prefix: ['dsh'], display: `pnpm dsh（${source}）`, cwd: source }
  }
  throw new Error('找不到 dsh CLI。请先安装 DeepSeek Harness，或使用 --dsh-bin 指定可执行文件')
}

async function runDsh(
  runner: DshRunner,
  argv: string[],
  dshHome: string,
  stdio: 'inherit' | 'pipe' | 'stderr' = 'inherit',
): Promise<{
  stdout: string
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(runner.executable, [...runner.prefix, ...argv], {
      ...(runner.cwd === undefined ? {} : { cwd: runner.cwd }),
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    if (stdio !== 'inherit') {
      child.stdout?.on('data', chunk => {
        stdout += String(chunk)
        if (stdio === 'stderr') process.stderr.write(chunk)
      })
      child.stderr?.on('data', chunk => {
        stderr += String(chunk)
        if (stdio === 'stderr') process.stderr.write(chunk)
      })
    }
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun({ stdout })
      else reject(new Error(`dsh 命令失败（退出码 ${code ?? 'unknown'}）${stderr.trim() === '' ? '' : `：${stderr.trim()}`}`))
    })
  })
}

async function pluginInstalled(profileDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return manifest.dependencies?.[PACKAGE_NAME] !== undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function setup(args: ParsedArgs, runtime: CliRuntime): Promise<SetupResult> {
  const json = args.flags.has('json')
  const profile = validateProfile(args.values.get('profile') ?? DEFAULT_PROFILE)
  const dshHome = dshHomeFrom(args)
  const projectPath = await validateProject(args.values.get('project') ?? process.cwd())
  const existing = await profileConfiguration(dshHome, profile)
  const existingBrand = existing.config.brand === 'lark' || existing.config.brand === 'feishu' || existing.config.brand === 'larkoffice'
    ? existing.config.brand
    : undefined
  const explicitBrand = args.values.has('brand') || existingBrand !== undefined
  let brand = validateBrand(args.values.get('brand') ?? existingBrand ?? 'feishu')
  let appId = args.values.get('app-id') ?? (typeof existing.config.appId === 'string' ? existing.config.appId : process.env.DSH_LARK_APP_ID)
  const appSecretRef = typeof existing.config.appSecretRef === 'string' && existing.config.appSecretRef.trim() !== ''
    ? existing.config.appSecretRef
    : credentialRefFor(profile)
  const credentialsPath = join(dshHome, '.credentials.yaml')
  const storedSecret = await readCredential(credentialsPath, appSecretRef)
  const profileSecret = typeof existing.config.appSecret === 'string' && existing.config.appSecret.trim() !== ''
    ? existing.config.appSecret.trim()
    : undefined
  let registeredSecret: string | undefined
  let registeredOwner: string | undefined
  let createdApp = false

  info('🚀 DeepSeek Harness Lark Bridge 接入向导', json)
  if (appId === undefined || appId.trim() === '') {
    if (args.flags.has('manual')) {
      const url = setupUrl(brand)
      info(`1/5 在官方开发者后台创建并发布机器人应用：\n${url}`, json)
      if (!args.flags.has('no-open')) await runtime.openUrl(url)
      appId = await ask('App ID（cli_...）')
    } else {
      if ((storedSecret !== undefined || profileSecret !== undefined) && !args.flags.has('force')) {
        throw new Error(`检测到未绑定 App ID 的旧凭据 ${appSecretRef}；请先确认来源，或添加 --force 后创建新应用`)
      }
      const created = await createApp(args, json, runtime)
      appId = created.appId
      registeredSecret = created.secret
      registeredOwner = created.ownerOpenId
      createdApp = true
      if (!explicitBrand && created.tenantBrand !== undefined) brand = created.tenantBrand
      info('1/5 新应用已创建，App ID 与 App Secret 已自动取得。', json)
    }
  } else {
    info('1/5 已检测到 App ID；只配置本机，不修改已有应用。', json)
  }
  appId = validateAppId(appId)
  const configuredAppId = typeof existing.config.appId === 'string' ? existing.config.appId : undefined
  if (configuredAppId !== undefined && configuredAppId !== '' && configuredAppId !== appId && !args.flags.has('force')) {
    throw new Error('Profile 已绑定另一个 App ID；如确需替换，请重新运行并添加 --force')
  }

  let secret: string
  let shouldWriteSecret = false
  if (registeredSecret !== undefined) {
    secret = registeredSecret
    shouldWriteSecret = storedSecret !== registeredSecret
    registeredSecret = undefined
    info('2/5 新应用凭据将写入 Harness 的本机私密存储。', json)
  } else if (args.flags.has('app-secret-stdin')) {
    secret = await readStdinSecret()
    info('2/5 已从 stdin 安全读取 App Secret。', json)
    shouldWriteSecret = storedSecret !== secret
    if ((storedSecret !== undefined && storedSecret !== secret
      || profileSecret !== undefined && profileSecret !== secret) && !args.flags.has('force')) {
      throw new Error(`凭据 ${appSecretRef} 已存在且不同；确认替换时请添加 --force`)
    }
  } else if (profileSecret !== undefined) {
    if (storedSecret !== undefined && storedSecret !== profileSecret && !args.flags.has('force')) {
      throw new Error(`Profile 明文密钥与凭据 ${appSecretRef} 不同；确认迁移 Profile 密钥时请添加 --force`)
    }
    secret = profileSecret
    shouldWriteSecret = storedSecret !== secret
    info('2/5 已检测到旧 Profile 明文密钥，将迁移到 Harness 凭据存储。', json)
  } else {
    const environmentSecret = process.env[appSecretRef] || process.env.DSH_LARK_APP_SECRET
    if (environmentSecret !== undefined && environmentSecret.trim() !== '') {
      secret = environmentSecret.trim()
      if (storedSecret !== undefined && storedSecret !== secret && !args.flags.has('force')) {
        throw new Error(`凭据 ${appSecretRef} 已存在且不同；确认替换时请添加 --force`)
      }
      shouldWriteSecret = storedSecret !== secret
      info('2/5 已检测到环境变量中的 App Secret，将迁移到 Harness 凭据存储。', json)
    } else if (storedSecret !== undefined) {
      secret = storedSecret
      info('2/5 已检测到 Harness 凭据存储，跳过密钥输入。', json)
    } else {
      secret = await askSecret('2/5 App Secret（输入不会显示）')
      if (secret === '') throw new Error('App Secret 不能为空')
      shouldWriteSecret = true
    }
  }

  if (!args.flags.has('no-verify')) {
    await validateCredentials(appId, secret, brand)
    info('3/5 应用凭据验证通过。', json)
  } else {
    info('3/5 已跳过应用凭据联网验证。', json)
  }

  if (shouldWriteSecret) await writeCredential(credentialsPath, appSecretRef, secret)
  secret = ''
  const statePath = typeof existing.config.statePath === 'string' && existing.config.statePath.trim() !== ''
    ? resolve(existing.config.statePath)
    : join(existing.profileDir, 'lark-bridge.state.json')
  const { projectId } = await writeProfileConfig({
    path: existing.patchPath,
    appId,
    appSecretRef,
    brand,
    statePath,
    projectPath,
    force: args.flags.has('force'),
  })
  const state = new BridgeStateStore(statePath)
  await state.refresh()
  if (registeredOwner !== undefined) await state.addOwner(registeredOwner, { welcome: true })
  const ownerBound = state.snapshot().owners.length > 0
  const pairing = ownerBound ? undefined : await state.createPairing()

  const runner = args.flags.has('no-install') && args.flags.has('no-start')
    ? undefined
    : await resolveDshRunner(args)
  let installed = await pluginInstalled(existing.profileDir)
  if (!args.flags.has('no-install') && !installed) {
    info(`4/5 正在安装插件到 Profile “${profile}”…`, json)
    await runDsh(
      runner!,
      ['plugin', '--profile', profile, 'add', args.values.get('plugin-source') ?? DEFAULT_PLUGIN_SOURCE],
      dshHome,
      json ? 'stderr' : 'inherit',
    )
    installed = true
  } else {
    info(`4/5 插件${installed ? '已经安装' : '安装步骤已跳过'}。`, json)
    await mkdir(existing.profileDir, { recursive: true, mode: 0o700 })
  }

  const openBotUrl = botUrl(brand, appId)
  const claimCommand = pairing === undefined ? undefined : `/claim ${pairing.token}`
  info(ownerBound
    ? `5/5 本地配置完成，当前用户已自动绑定。\n\n打开机器人：${openBotUrl}\n`
    : `5/5 本地配置完成。\n\n打开机器人：${openBotUrl}\n发送：${claimCommand}\n`, json)
  if (!args.flags.has('no-open')) await runtime.openUrl(openBotUrl)

  const start = !args.flags.has('no-start')
  const result: SetupResult = {
    profile,
    project: projectId,
    appId,
    brand,
    statePath,
    botUrl: openBotUrl,
    ...(claimCommand === undefined ? {} : { claimCommand }),
    ...(pairing === undefined ? {} : { pairingExpiresAt: pairing.expiresAt }),
    createdApp,
    ownerBound,
    installed,
    started: start,
  }
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`)
  if (start) {
    info(`正在启动：${runner!.display} --profile ${profile}\n保持当前窗口运行，然后回到飞书。`, json)
    await runDsh(runner!, ['--profile', profile], dshHome, json ? 'stderr' : 'inherit')
  }
  return result
}

async function pair(args: ParsedArgs, runtime: CliRuntime): Promise<void> {
  const json = args.flags.has('json')
  const profile = validateProfile(args.values.get('profile') ?? DEFAULT_PROFILE)
  const dshHome = dshHomeFrom(args)
  const { config } = await profileConfiguration(dshHome, profile)
  if (typeof config.appId !== 'string' || config.appId === '') throw new Error(`Profile “${profile}” 尚未完成 setup`)
  const brand = config.brand === 'lark' || config.brand === 'larkoffice' ? config.brand : 'feishu'
  const statePath = typeof config.statePath === 'string' && config.statePath !== ''
    ? resolve(config.statePath)
    : join(dshHome, 'profiles', profile, 'lark-bridge.state.json')
  const pairing = await new BridgeStateStore(statePath).createPairing()
  const data = {
    profile,
    botUrl: botUrl(brand, config.appId),
    claimCommand: `/claim ${pairing.token}`,
    pairingExpiresAt: pairing.expiresAt,
  }
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`)
  else process.stdout.write(`打开机器人：${data.botUrl}\n发送：${data.claimCommand}\n配对码十分钟内有效，且只能成功使用一次。\n`)
  if (!args.flags.has('no-open')) await runtime.openUrl(data.botUrl)
}

async function doctor(args: ParsedArgs): Promise<void> {
  const json = args.flags.has('json')
  const profile = validateProfile(args.values.get('profile') ?? DEFAULT_PROFILE)
  const dshHome = dshHomeFrom(args)
  const details: Array<{ check: string; ok: boolean; detail: string; required?: boolean }> = []
  const { profileDir, config } = await profileConfiguration(dshHome, profile)
  const installed = await pluginInstalled(profileDir)
  details.push({ check: 'plugin', ok: installed, detail: installed ? '已安装' : '未安装' })
  const appId = typeof config.appId === 'string' ? config.appId : ''
  details.push({ check: 'appId', ok: /^cli_[A-Za-z0-9]+$/u.test(appId), detail: appId === '' ? '未配置' : '已配置' })
  const ref = typeof config.appSecretRef === 'string' && config.appSecretRef !== ''
    ? config.appSecretRef
    : credentialRefFor(profile)
  const credential = await readCredential(join(dshHome, '.credentials.yaml'), ref)
  details.push({ check: 'credential', ok: credential !== undefined, detail: credential === undefined ? '未配置' : `已配置引用 ${ref}` })
  const statePath = typeof config.statePath === 'string' && config.statePath !== ''
    ? resolve(config.statePath)
    : join(profileDir, 'lark-bridge.state.json')
  const state = await new BridgeStateStore(statePath).refresh()
  details.push({
    check: 'owner',
    ok: state.owners.length > 0,
    detail: state.owners.length > 0 ? `已配对 ${state.owners.length} 位用户` : '尚未完成 /claim',
  })
  details.push({
    check: 'cardCallback',
    ok: state.cardVerifiedAt !== undefined,
    detail: state.cardVerifiedAt === undefined ? '可选检查，尚未点击测试按钮' : '已验证',
    required: false,
  })
  if (appId !== '' && credential !== undefined && !args.flags.has('no-verify')) {
    try {
      await validateCredentials(
        appId,
        credential,
        config.brand === 'lark' || config.brand === 'larkoffice' ? config.brand : 'feishu',
      )
      details.push({ check: 'apiCredential', ok: true, detail: '飞书 API 验证通过' })
    } catch (error) {
      details.push({ check: 'apiCredential', ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const healthy = details.filter(item => item.required !== false).every(item => item.ok)
  if (json) process.stdout.write(`${JSON.stringify({ ok: healthy, data: { profile, checks: details } })}\n`)
  else {
    for (const item of details) {
      const icon = item.ok ? '✅' : item.required === false ? '➖' : '❌'
      process.stdout.write(`${icon} ${item.check}：${item.detail}\n`)
    }
    if (!healthy) process.exitCode = 1
  }
}

export async function main(argv = process.argv.slice(2), runtime: CliRuntime = DEFAULT_RUNTIME): Promise<void> {
  const args = parseArgs(argv)
  if (args.command === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (args.command === 'setup') await setup(args, runtime)
  else if (args.command === 'pair') await pair(args, runtime)
  else await doctor(args)
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  void main().catch(error => {
    const json = process.argv.includes('--json')
    const message = error instanceof Error ? error.message : String(error)
    if (json) process.stderr.write(`${JSON.stringify({ ok: false, error: { message } })}\n`)
    else process.stderr.write(`❌ ${message}\n`)
    process.exitCode = 1
  })
}

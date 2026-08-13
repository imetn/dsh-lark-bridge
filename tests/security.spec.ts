import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boundedUtf8Buffer,
  imageMediaType,
  isOpenIdAllowed,
  readBufferWithLimit,
  redactSecrets,
  resolveOutboundFile,
  safeFileName,
  saveInboundFile,
} from '../src/security.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-security-'))
  roots.push(root)
  return root
}

describe('security helpers', () => {
  it('redacts provider keys, bearer credentials, and named secret assignments', () => {
    const output = redactSecrets('api_key=abc123xyz token: topsecret Bearer aa.bb.cc sk-1234567890abcdef')
    expect(output).not.toContain('abc123xyz')
    expect(output).not.toContain('topsecret')
    expect(output).not.toContain('aa.bb.cc')
    expect(output).not.toContain('sk-1234567890abcdef')
    expect(output.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(4)
  })

  it('normalizes hostile attachment names', () => {
    expect(safeFileName('../../bad\\name?.txt', 'fallback.bin')).toBe('name_.txt')
    expect(safeFileName('...', 'fallback.bin')).toBe('fallback.bin')
  })

  it('intersects bridge-wide and project-specific user access', () => {
    expect(isOpenIdAllowed('ou_owner', false, ['ou_owner'], ['ou_owner'])).toBe(true)
    expect(isOpenIdAllowed('ou_owner', false, ['ou_owner'], [])).toBe(true)
    expect(isOpenIdAllowed('ou_other', false, ['ou_owner'], ['ou_other'])).toBe(false)
    expect(isOpenIdAllowed('ou_other', true, [], ['ou_owner'])).toBe(false)
    expect(isOpenIdAllowed('ou_other', true, [], [])).toBe(true)
  })

  it('rejects symlinks escaping the workspace and enforces size', async () => {
    const workspace = await tempRoot()
    const outside = await tempRoot()
    await writeFile(join(workspace, 'ok.txt'), 'hello')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'))
    await expect(resolveOutboundFile(workspace, workspace, 'ok.txt', 5)).resolves.toMatchObject({ bytes: 5 })
    await expect(resolveOutboundFile(workspace, workspace, 'ok.txt', 4)).rejects.toThrow('outbound limit')
    await expect(resolveOutboundFile(workspace, workspace, 'escape.txt', 100)).rejects.toThrow('outside')
  })

  it('writes inbound data as a private exclusive file', async () => {
    const workspace = await tempRoot()
    const inbox = join(workspace, 'inbox')
    await mkdir(inbox)
    await chmod(inbox, 0o700)
    const saved = await saveInboundFile(inbox, 'session:key', '../demo.txt', Buffer.from('hello'), 10)
    expect(saved.fileName).toBe('demo.txt')
    expect((await lstat(saved.absolutePath)).mode & 0o777).toBe(0o600)
  })

  it('stops streaming inbound data as soon as it exceeds the limit', async () => {
    await expect(readBufferWithLimit(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 5))
      .rejects.toThrow('inbound limit')
    await expect(readBufferWithLimit(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 6))
      .resolves.toEqual(Buffer.from('abcdef'))
  })

  it('recognizes supported image magic bytes', () => {
    expect(imageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe('image/png')
    expect(imageMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(imageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(imageMediaType(Buffer.from('not image'), 'asset.webp')).toBe('image/webp')
  })

  it('bounds long Markdown by UTF-8 bytes without splitting surrogate pairs', () => {
    const output = boundedUtf8Buffer('开头🙂'.repeat(30), 80)
    expect(output.byteLength).toBeLessThanOrEqual(80)
    expect(output.toString('utf8')).toContain('已截断')
    expect(output.toString('utf8')).not.toContain('\ufffd')
    expect(boundedUtf8Buffer('hello', 5).toString()).toBe('hello')
    expect(boundedUtf8Buffer('hello', 2).toString()).toBe('..')
    expect(() => boundedUtf8Buffer('hello', 0)).toThrow('positive safe integer')
  })
})

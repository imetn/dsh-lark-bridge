import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as plugin from '../lib/index.js'

assert.equal('default' in plugin, false, 'built plugin must not export default')
const loader = Object.create(Loader.prototype)
const unwrapped = loader.unwrapExports(plugin)
assert.equal(unwrapped, plugin)
assert.equal(unwrapped.name, 'dsh-lark-bridge')
assert.deepEqual(unwrapped.inject, ['agents', 'agentDefaultModel', 'credentials', 'tools', 'systemPrompt'])
assert.equal(typeof unwrapped.Config, 'function')
assert.equal(typeof unwrapped.apply, 'function')
assert.ok((await stat(new URL('../lib/index.js', import.meta.url))).size < 3_500_000, 'runtime bundle unexpectedly large')
const notices = await readFile(new URL('../lib/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8')
assert.match(notices, /@larksuiteoapi\/node-sdk@1\.73\.0/u)
assert.match(notices, /protobufjs@7\./u)
const cliHelp = execFileSync(process.execPath, [fileURLToPath(new URL('../lib/cli.js', import.meta.url)), '--help'], { encoding: 'utf8' })
assert.match(cliHelp, /dsh-lark setup/u)
assert.doesNotMatch(cliHelp, /--app-secret <value>/u)

console.log('built Loader contract passed')

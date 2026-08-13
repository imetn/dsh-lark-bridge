import { build } from 'esbuild'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

mkdirSync('lib', { recursive: true })
rmSync('lib/index.js.map', { force: true })

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  sourcemap: false,
  external: ['@deepseek-ai/*'],
  mainFields: ['module', 'main'],
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'external',
  metafile: true,
  logLevel: 'info',
})

const licenseCandidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING']
const bundledPackages = new Map()

function findPackageRoot(input) {
  let directory = dirname(realpathSync(resolve(input)))
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) return directory
    directory = dirname(directory)
  }
  return undefined
}

for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue
  const packageRoot = findPackageRoot(input)
  if (packageRoot === undefined) continue
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const key = `${manifest.name}@${manifest.version}`
  if (bundledPackages.has(key)) continue
  const licensePath = licenseCandidates.map(name => join(packageRoot, name)).find(existsSync)
  bundledPackages.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? 'UNKNOWN',
    homepage: manifest.homepage ?? manifest.repository?.url ?? '',
    text: licensePath === undefined
      ? 'The installed package did not include a standalone license file.'
      : readFileSync(licensePath, 'utf8').replace(/\r\n?/gu, '\n').trim(),
  })
}

const notices = [...bundledPackages.values()]
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
  .map(item => [
    '='.repeat(80),
    `${item.name}@${item.version} — ${item.license}`,
    item.homepage,
    '',
    item.text,
  ].filter((line, index) => line !== '' || index > 2).join('\n'))

writeFileSync('lib/THIRD_PARTY_NOTICES.txt', [
  'DeepSeek Harness Lark Bridge bundles the following runtime dependencies.',
  'Their notices and license texts are reproduced below.',
  '',
  ...notices,
  '',
].join('\n'))

execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' })

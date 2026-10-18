// Artifact-only observation. No configuration setter, parser, test, or exporter CLI is invoked.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [source, output] = process.argv.slice(2)
const require = createRequire(join(source, 'packages/contracts/package.json'))
const packageFile = require.resolve('zod/package.json')
const packageJSON = JSON.parse(await readFile(packageFile, 'utf8'))
if (packageJSON.version !== '4.6.3' || packageJSON.exports['.'].import !== './index.js') throw new Error('Pinned Zod ESM required')
const root = dirname(packageFile)
const { z } = await import(pathToFileURL(join(root, 'index.js')).href)
const initialMemoizer = z.config().memoizer
let previousMemoizer = initialMemoizer
const snapshots = []
function snapshot(phase) {
  const config = z.config()
  const memoizer = config.memoizer
  snapshots.push({ phase, keys: Object.keys(config), types: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value])),
    memoizer: { present: Object.hasOwn(config, 'memoizer'), type: typeof memoizer,
      sameAsInitial: Object.is(memoizer, initialMemoizer), sameAsPrevious: Object.is(memoizer, previousMemoizer) } })
  previousMemoizer = memoizer
}
snapshot('after-pinned-zod-esm-import')
await import(pathToFileURL(join(source, 'scripts/go-contracts/export-schemas.mjs')).href)
snapshot('after-actual-exporter-module-import-without-cli-or-policy-call')
const primitives = await import(pathToFileURL(join(source, 'packages/contracts/dist/schemaPrimitives.js')).href)
snapshot('after-actual-schema-primitives-import')
const principals = await import(pathToFileURL(join(source, 'packages/contracts/dist/management/principals.js')).href)
snapshot('after-actual-management-principals-import')
const selected = [['.#IdSchema', primitives.IdSchema], ['./management#ManagementActionSchema', principals.ManagementActionSchema],
  ['./management#ManagementGrantSchema', principals.ManagementGrantSchema], ['./management#ManagementPrincipalSchema', principals.ManagementPrincipalSchema]]
const sourceBytes = await readFile(join(root, 'src/v4/locales/en.ts'))
const installedBytes = await readFile(join(root, 'v4/locales/en.js'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceBlob = createHash('sha1').update('blob ' + sourceBytes.length + '\0').update(sourceBytes).digest('hex')
await writeFile(join(output, 'zod-en-source.ts'), sourceBytes)
await writeFile(join(output, 'zod-en-installed.mjs'), installedBytes)
const observation = { schemaVersion: 1, snapshots,
  selectedSchemas: selected.map(([id, schema]) => ({ id, safeParseType: typeof schema?.safeParse })),
  zod: { name: packageJSON.name, version: packageJSON.version, esmEntry: packageJSON.exports['.'].import },
  locale: { sourceBlob, sourceSHA256: sha256(sourceBytes), installedSHA256: sha256(installedBytes) },
  configurationSettersInvoked: false, exporterCLIInvoked: false, testsInvoked: false }
await writeFile(join(output, 'zod-config-observation.json'), JSON.stringify(observation, null, 2))
process.stdout.write(JSON.stringify(observation) + '\n')
if (sourceBlob !== '3836bd1651071082fb24488d4e3b3d29db851134') process.exitCode = 1

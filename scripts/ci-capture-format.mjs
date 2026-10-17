import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const candidate = 'e373f5425fba124b1abb048b76e18434c9e69d57'
const expected = {
  'backend/internal/app/database_errors_integration_test.go': '9b6a873b3bb723219363271e6f7002ca45088e8f',
  'backend/internal/config/validation_test.go': 'f87d97045ffcddb2e3de7f5521805522f8fe15a4',
  'backend/internal/database/retry.go': 'a7807adf25fef77b1067977adf94130619f131c2',
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function artifact(path, bytes) {
  bytes = Buffer.from(bytes)
  const chunks = gzipSync(bytes).toString('base64').match(/.{1,6000}/g) ?? []
  console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'artifact', path, bytes: bytes.length,
    sha256: digest(bytes), encoding: 'gzip+base64', chunks: chunks.length })}`)
  for (let index = 0; index < chunks.length; index++) {
    console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'chunk', path, index, data: chunks[index] })}`)
  }
}

if (process.env.CI !== 'true' && process.env.CI !== '1') throw new Error('Formatting capture runs only inside Foreman CI.')
const files = Object.keys(expected)
console.log(`[capture-format] formatting ${files.length} verified candidate files with pinned Go`)
const manifest = { candidate, tool: 'gofmt from pinned Go 1.27.2', files: [] }
for (const path of files) {
  const before = readFileSync(path)
  const blob = createHash('sha1').update(`blob ${before.length}\0`).update(before).digest('hex')
  if (blob !== expected[path]) throw new Error(`Candidate source preimage mismatch: ${path}`)
  manifest.files.push({ path, preimageGitBlob: blob, preimageBytes: before.length, preimageSha256: digest(before) })
}
const result = spawnSync('gofmt', ['-w', ...files], { encoding: 'utf8', timeout: 30_000 })
if (result.error || result.status !== 0) throw new Error('Pinned gofmt failed; no formatted artifacts emitted.')
const check = spawnSync('gofmt', ['-l', ...files], { encoding: 'utf8', timeout: 30_000 })
if (check.error || check.status !== 0 || check.stdout.trim()) throw new Error('Formatted files did not pass pinned gofmt readback.')
for (const record of manifest.files) {
  const bytes = readFileSync(record.path)
  Object.assign(record, { resultBytes: bytes.length, resultSha256: digest(bytes) })
  artifact(record.path, bytes)
}
artifact('format-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
console.log('FOREMAN_CAPTURE {"kind":"complete"}')

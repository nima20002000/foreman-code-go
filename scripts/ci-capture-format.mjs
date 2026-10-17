import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const candidate = 'fc326c28fbea28d9964bdd25abef0c286faad65f'
const expected = {
  'backend/internal/app/app.go': 'a512fa6b728395d7dee8c2e97d85b4d4375bc9a8',
  'backend/internal/config/env_file_test.go': 'da1980b2d1acf7733457110ffb3ef41c419e38b1',
  'backend/internal/database/transaction_timing.go': 'ed0142c6cb108fadf9491ce002aa400eb7e34c98',
  'backend/internal/domainerror/codes.go': 'f5d670b02d5df4441d426549d5d3c1a6e214175e',
  'backend/internal/health/health_test.go': 'f8f11cc6c8bc95bfcd6fa187cdba19a1d35df131',
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

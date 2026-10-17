import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const expectedBytes = 75779124
const expectedSha256 = '3a467ed067f27cd55bf3a702f8e2bf12479f53c9d8ae0de548f48ebcb3c67796'
const moduleH1 = 'h1:N6Xv/1OLzI0jVVkUwkrxHRZc/GCTARUo6idcngKwlDE='
const moduleVersion = 'v0.0.1-go1.27.2.linux-amd64'
const sourceUrl = `https://proxy.golang.org/golang.org/toolchain/@v/${moduleVersion}.zip`
const parent = join(await realpath(homedir()), '.cache', 'foreman-go-zip')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'z-'))
function record(value) {
  console.log('[go-zip] ' + JSON.stringify(value))
}
const progress = setInterval(() => record({ stage: 'official-module-download-running' }), 15000)
try {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) })
  record({ stage: 'official-module-response', sourceUrl, status: response.status })
  if (!response.ok || !response.body) throw new Error('Official module ZIP download failed')
  const hash = createHash('sha256')
  let bytes = 0
  const stream = Readable.fromWeb(response.body)
  stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk) })
  await pipeline(stream, createWriteStream(join(root, 'toolchain.zip'), { flags: 'wx', mode: 0o600 }))
  const sha256 = hash.digest('hex')
  if (bytes !== expectedBytes || sha256 !== expectedSha256) throw new Error('Verified ZIP digest or size mismatch')
  record({ stage: 'verified-download', version: 'go1.27.2', moduleVersion, moduleH1,
    sourceUrl, zipBytes: bytes, zipSha256: sha256, executed: false,
    digestSourceCommit: '2c2380b23ed16b11fbcdd737fd7e23fac4df72b5',
    digestSourceTicket: 'af0b04c8-4351-42e3-aafa-9e600111a067',
    sourceBaseline: '65194efa709d581b84d57de8309a16c7cc0a6e7c' })
} catch (error) {
  process.exitCode = 1
  record({ stage: 'failed', message: error.message })
} finally {
  clearInterval(progress)
  await rm(root, { recursive: true, force: true })
  record({ stage: 'cleanup', ownedCacheRemoved: true })
}

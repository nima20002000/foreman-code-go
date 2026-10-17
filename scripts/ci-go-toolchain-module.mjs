import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// Only the authenticated, exactly pinned Go module ZIP is accepted. No package or compiler is installed to unpack it.
const [archive, destination, prefix, expectedSize, expectedSha256, expectedSum] = process.argv.slice(2)
const maxModuleSize = 500 * 1024 * 1024
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function directoryRecord(zip) {
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset--) {
    if (zip.readUInt32LE(offset) !== 0x06054b50) continue
    if (offset + 22 + zip.readUInt16LE(offset + 20) !== zip.length) continue
    const count = zip.readUInt16LE(offset + 10)
    const size = zip.readUInt32LE(offset + 12)
    const start = zip.readUInt32LE(offset + 16)
    if (zip.readUInt16LE(offset + 4) !== 0 || zip.readUInt16LE(offset + 6) !== 0
      || zip.readUInt16LE(offset + 8) !== count || count === 0 || count === 0xffff
      || start + size !== offset) throw new Error('Unsupported Go toolchain ZIP directory')
    return { start, end: offset, count }
  }
  throw new Error('The Go toolchain ZIP directory is missing')
}

function entryPath(name, mode) {
  if (!name.startsWith(`${prefix}/`) || ['\\', '\0', '\r', '\n'].some(character => name.includes(character))) {
    throw new Error('Unsafe Go toolchain ZIP path')
  }
  const relative = name.slice(prefix.length + 1)
  const directory = name.endsWith('/')
  const parts = (directory ? relative.slice(0, -1) : relative).split('/')
  if (relative && parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe Go toolchain ZIP path')
  const type = mode & 0o170000
  if (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) {
    throw new Error('The Go toolchain ZIP must contain only regular files and directories')
  }
  return { relative, directory }
}

function entriesIn(zip) {
  const directory = directoryRecord(zip)
  const entries = []
  const names = new Set()
  let offset = directory.start
  let expandedSize = 0
  while (offset < directory.end) {
    if (offset + 46 > directory.end || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Malformed Go toolchain ZIP entry')
    }
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const end = offset + 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32)
    if (end > directory.end || flags & 1 || ![0, 8].includes(method) || zip.readUInt16LE(offset + 34) !== 0) {
      throw new Error('Unsupported Go toolchain ZIP entry')
    }
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    const path = entryPath(name, zip.readUInt32LE(offset + 38) >>> 16)
    if (names.has(name)) throw new Error('Duplicate Go toolchain ZIP path')
    names.add(name)
    expandedSize += size
    if (expandedSize > maxModuleSize) throw new Error('Go toolchain ZIP exceeds the module size limit')
    const local = zip.readUInt32LE(offset + 42)
    if (local + 30 > directory.start || zip.readUInt32LE(local) !== 0x04034b50
      || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) {
      throw new Error('Malformed Go toolchain ZIP local entry')
    }
    const localNameEnd = local + 30 + zip.readUInt16LE(local + 26)
    const dataOffset = localNameEnd + zip.readUInt16LE(local + 28)
    if (dataOffset + compressedSize > directory.start
      || !zip.subarray(local + 30, localNameEnd).equals(nameBytes)) {
      throw new Error('Inconsistent Go toolchain ZIP local entry')
    }
    entries.push({ name, nameBytes, ...path, method, compressedSize, size, dataOffset })
    offset = end
  }
  if (offset !== directory.end || entries.length !== directory.count) throw new Error('Incomplete Go toolchain ZIP directory')
  return entries
}

function contents(zip, entry) {
  const compressed = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) })
  if (bytes.length !== entry.size || entry.directory && bytes.length !== 0) throw new Error('Invalid Go toolchain ZIP entry size')
  return bytes
}

function verifyModule(zip, entries) {
  // Go's dirhash.HashZip h1 covers sorted full ZIP names and content hashes, independently of ZIP encoding/metadata.
  // https://go.dev/src/cmd/vendor/golang.org/x/mod/sumdb/dirhash/hash.go
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes))) {
    hash.update(`${sha256(contents(zip, entry))}  ${entry.name}\n`)
  }
  if (`h1:${hash.digest('base64')}` !== expectedSum) throw new Error('Go toolchain module h1 mismatch')
  for (const required of ['bin/go', 'bin/gofmt', 'src/_go.mod']) {
    if (!entries.some(entry => entry.relative === required && !entry.directory)) {
      throw new Error(`Go toolchain module is missing ${required}`)
    }
  }
}

function extractModule(zip, entries) {
  mkdirSync(destination, { mode: 0o700 })
  for (const entry of entries) {
    const file = join(destination, entry.relative)
    if (entry.directory) {
      mkdirSync(file, { recursive: true, mode: 0o700 })
      continue
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // Restore the executable paths that Go's own SDK downloader enables; module ZIPs omit executable permissions.
    // https://go.dev/src/cmd/go/internal/toolchain/select.go
    const executable = entry.relative.startsWith('bin/') || entry.relative.startsWith('pkg/tool/')
      || entry.relative.startsWith('lib/') && /^go_.+_.+_exec$/.test(basename(file))
    const bytes = contents(zip, entry)
    writeFileSync(file, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 })
    // The SDK restores every packaged _go.mod only after its authenticated content has been checked.
    if (basename(file) === '_go.mod') writeFileSync(join(dirname(file), 'go.mod'), bytes, { flag: 'wx', mode: 0o600 })
  }
}

try {
  if (!/^golang\.org\/toolchain@v0\.0\.1-go\d+\.\d+\.\d+\.linux-(amd64|arm64)$/.test(prefix)
    || !/^[a-f0-9]{64}$/.test(expectedSha256) || !/^h1:[A-Za-z0-9+/]{43}=$/.test(expectedSum)
    || !/^[1-9][0-9]*$/.test(expectedSize) || Number(expectedSize) > maxModuleSize) {
    throw new Error('Invalid pinned Go toolchain module arguments')
  }
  const zip = readFileSync(archive)
  if (zip.length !== Number(expectedSize)) throw new Error('Go toolchain ZIP size mismatch')
  if (sha256(zip) !== expectedSha256) throw new Error('Go toolchain ZIP SHA256 mismatch')
  const entries = entriesIn(zip)
  verifyModule(zip, entries)
  extractModule(zip, entries)
  console.error(`Prepared ${prefix} with its pinned ZIP SHA256 and module ${expectedSum}.`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}

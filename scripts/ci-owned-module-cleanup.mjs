import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = join(await realpath(homedir()), '.cache/foreman-main-go-diagnostic/g-fDwDez')
const moduleCache = join(root, 'modules')
const compilerRoot = join(root, 'compiler-cache/toolchains/go1.27.2')
const sentinel = await readFile(join(root, 'caller-sentinel'), 'utf8')
if (sentinel !== 'caller-owned-state\n') throw new Error('Owned cleanup sentinel mismatch')
for (const path of [root, moduleCache, compilerRoot]) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error('Cleanup root is not a directory owned by this CI user')
  }
}
const bytes = await readFile(join(root, 'selected.vitest.json'))
const encoded = gzipSync(bytes).toString('base64')
const chunks = encoded.match(/.{1,24000}/g) ?? []
console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: 'selected-Go-report.json',
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  encoding: 'gzip+base64', chunks: chunks.length }))
chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({
  kind: 'chunk', path: 'selected-Go-report.json', index, data })))
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  GOROOT: compilerRoot, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off',
  GOMODCACHE: moduleCache, GOCACHE: join(root, 'build'), GOPATH: join(root, 'gopath') }
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(join(compilerRoot, 'bin/go'), ['clean', '-modcache'], {
    env, cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  child.once('error', reject)
  child.once('close', code => resolve(code ?? 1))
})
console.log('[owned-cleanup] ' + JSON.stringify({ sourceTicket: 'e88097a3-9797-4568-9831-e83825b68916',
  operation: 'pinned Go clean -modcache', exitCode, scope: 'exact failed controller-owned module cache' }))
if (exitCode !== 0) throw new Error('Owned Go module cache cleanup failed')
await rm(root, { recursive: true, force: true })
console.log('[owned-cleanup] ' + JSON.stringify({ cleanup: true, testsExecuted: 0, sourceTicketUnchanged: true }))

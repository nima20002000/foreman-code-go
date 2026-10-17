import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const failedCache = join(await realpath(homedir()), '.cache/foreman-main-go-diagnostic/g-MgEb3n')
const facts = { observedAt: new Date().toISOString(), source: '0e40b1dbe160f02c88e94a3508e3fafcd3213bea',
  failedTicket: 'd23b7cfe-ab0b-49f6-8379-653f6d4b1315', readOnly: true,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  currentUid: process.getuid(), paths: [], matchedProcesses: [], unreadableOwnedExecutables: 0 }
for (const [name, path] of [['failed-owned-cache', failedCache],
  ['failed-probe', join(failedCache, 'compiler-cache/toolchain-probe.Lx5Hwj')]]) {
  try {
    const entry = await lstat(path)
    let writable = false
    try { await access(path, constants.W_OK); writable = true }
    catch (error) { if (error.code !== 'EACCES') throw error }
    facts.paths.push({ name, exists: true, directory: entry.isDirectory(), symlink: entry.isSymbolicLink(),
      ownedByCurrentUid: entry.uid === process.getuid(), mode: (entry.mode & 0o777).toString(8), writable })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    facts.paths.push({ name, exists: false })
  }
}
for (const entry of await readdir('/proc', { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue
  const directory = join('/proc', entry.name)
  try {
    if ((await stat(directory)).uid !== process.getuid()) continue
    let executable
    try { executable = await readlink(join(directory, 'exe')) }
    catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') { facts.unreadableOwnedExecutables++; continue }
      throw error
    }
    if (!executable.startsWith(failedCache + '/')) continue
    const arguments_ = (await readFile(join(directory, 'cmdline'), 'utf8')).split('\0')
    const environment = (await readFile(join(directory, 'environ'), 'utf8')).split('\0')
    facts.matchedProcesses.push({ pid: Number(entry.name), executableName: basename(executable.replace(/ \(deleted\)$/, '')),
      executableDeleted: executable.endsWith(' (deleted)'), telemetryArgument: arguments_.includes('telemetry'),
      uploadArgument: arguments_.includes('upload'),
      telemetryChildMarkerPresent: environment.some(value => value.startsWith('GOTELEMETRY_CHILD=')),
      telemetryDirectoryMarkerPresent: environment.some(value => value.startsWith('GOTELEMETRYDIR=')) })
  } catch (error) {
    // Processes can exit while /proc is read; no other errors are silently discarded.
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
  }
}
facts.limit = 'Observation is later than the failure; absent processes cannot rule out a transient writer during cleanup.'
console.log('[main-probe-observation] ' + JSON.stringify(facts))

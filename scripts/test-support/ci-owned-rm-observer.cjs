const { spawnSync } = require('node:child_process')
const { appendFileSync, readFileSync } = require('node:fs')
const { lstat, readdir, readFile, readlink, stat } = require('node:fs/promises')
const { basename, join } = require('node:path')

const state = JSON.parse(readFileSync(process.env.FOREMAN_PROBE_OBSERVATION_STATE, 'utf8'))
const args = process.argv.slice(2)
const result = spawnSync(state.realRm, args, { stdio: 'inherit' })
const originalExitCode = result.status ?? 1
const probe = args.find(value => value.startsWith(state.compilerPrefix + '/toolchain-probe.')
  && /^toolchain-probe\.[a-zA-Z0-9]{6}$/.test(basename(value)))

async function remainingNames(directory, prefix = '', depth = 0, names = []) {
  if (depth > 5 || names.length >= 80) return names
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()) return names
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    names.push(name + (entry.isDirectory() ? '/' : ''))
    if (entry.isDirectory() && names.length < 80) {
      try { await remainingNames(join(directory, entry.name), name + '/', depth + 1, names) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (names.length >= 80) break
  }
  return names
}

async function ownedCompilerProcesses() {
  const found = []
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue
    const directory = join('/proc', entry.name)
    try {
      if ((await stat(directory)).uid !== process.getuid()) continue
      let executable
      try { executable = await readlink(join(directory, 'exe')) }
      catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) continue; throw error }
      if (!executable.startsWith(state.compilerPrefix + '/')) continue
      const arguments_ = (await readFile(join(directory, 'cmdline'), 'utf8')).split('\0')
      const environment = (await readFile(join(directory, 'environ'), 'utf8')).split('\0')
      const status = await readFile(join(directory, 'stat'), 'utf8')
      const fields = status.slice(status.lastIndexOf(')') + 2).split(' ')
      found.push({ pid: Number(entry.name), parentPid: Number(fields[1]),
        telemetryArgument: arguments_.some(value => value === 'telemetry' || value === 'upload'),
        privateHome: environment.includes('HOME=' + join(probe, 'home')) })
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return found
}

async function observe() {
  if (!probe || originalExitCode === 0) return
  const event = { observedAt: new Date().toISOString(), probeName: basename(probe),
    originalRmExitCode: originalExitCode, originalRmSignal: result.signal, exactArgumentsForwarded: true }
  try { event.remainingRelativeNames = await remainingNames(probe) }
  catch (error) { event.directoryObservationError = error.code }
  try { event.ownedCompilerProcesses = await ownedCompilerProcesses() }
  catch (error) { event.processObservationError = error.code }
  appendFileSync(state.events, JSON.stringify(event) + '\n')
}

observe().catch(error => {
  appendFileSync(state.events, JSON.stringify({ observationError: error.code ?? error.name,
    originalRmExitCode: originalExitCode }) + '\n')
}).finally(() => {
  process.exitCode = originalExitCode
  if (result.signal) process.kill(process.pid, result.signal)
})

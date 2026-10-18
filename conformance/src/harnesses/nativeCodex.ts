import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandError } from '../runtime/commands.js'
import { waitForOwnedProcessesToExit } from '../runtime/owned-processes.js'

interface CompilerExit { code: number | null; signal: NodeJS.Signals | null }

function compilerFailure(code: string | number | undefined, detail: string): CommandError {
  const message = detail.trim().slice(-16_384)
  return new CommandError(`cc failed (${code ?? 'unknown'})${message ? `: ${message}` : ''}`, code)
}

/** Only a settled compiler returns an ordinary failure; uncertain ownership throws. */
async function compile(arguments_: string[], directory: string, environment: NodeJS.ProcessEnv): Promise<CommandError | undefined> {
  let child: ChildProcess
  try {
    child = spawn('cc', arguments_, { cwd: directory, env: environment, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return compilerFailure((error as NodeJS.ErrnoException).code, String(error))
  }
  let stderr = ''
  let processError: NodeJS.ErrnoException | undefined
  child.stdout?.resume()
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_384) })
  const closed = new Promise<CompilerExit>(resolve => {
    child.once('error', error => { processError = error })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const cleanupErrors: unknown[] = []
  const stopGroup = () => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error)
      // ignore: ESRCH means the owned compiler group has already exited.
    }
  }
  let expired = false
  const timeout = setTimeout(() => { expired = true; stopGroup() }, 15_000)
  let closeTimeout: NodeJS.Timeout | undefined
  let exit: CompilerExit | undefined
  try {
    exit = await Promise.race([closed, new Promise<undefined>(resolve => {
      closeTimeout = setTimeout(() => resolve(undefined), 20_000)
    })])
  } finally {
    clearTimeout(timeout)
    clearTimeout(closeTimeout)
    // A compiler driver can close while its assembler or linker still runs.
    stopGroup()
  }
  try { await waitForOwnedProcessesToExit(directory) }
  catch (error) { cleanupErrors.push(error) }
  if (!exit) cleanupErrors.push(new Error('The compiler did not close within 20 seconds.'))
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Compiler closure is unproven; its owned build directory is retained.')
  }
  if (processError) return compilerFailure(processError.code, `${processError.message}\n${stderr}`)
  if (expired) return compilerFailure('ETIMEDOUT', stderr)
  if (exit!.code !== 0) return compilerFailure(exit!.signal ?? exit!.code ?? undefined, stderr)
  return undefined
}

function boundPath(name: string, value: string): string {
  return `static const unsigned char ${name}[] = { ${[...Buffer.from(value, 'utf8'), 0].join(', ')} };\n`
}

/** Build only the isolated fixture; installed Codex packages are never consulted. */
export async function installCodexExecutable(binary: string, script: string, environment: NodeJS.ProcessEnv): Promise<void> {
  if (![binary, script, process.execPath].every(isAbsolute)) throw new Error('Absolute Codex fixture paths are required.')
  const directory = await mkdtemp(join(dirname(binary), '.codex-build-'))
  const header = join(directory, 'runtime-paths.h')
  const output = join(directory, 'codex')
  const source = fileURLToPath(new URL('../../fixtures/harnesses/codex-forwarder.c', import.meta.url))
  const failures: unknown[] = []
  let removable = true
  try {
    await writeFile(header, boundPath('fixture_node', process.execPath) + boundPath('fixture_script', script),
      { mode: 0o600, flag: 'wx' })
    removable = false
    const failure = await compile(['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-include', header, source, '-o', output], directory, environment)
    removable = true
    if (failure) throw new Error('Fresh Codex fixture setup requires a working C compiler.', { cause: failure })
    await chmod(output, 0o700)
    // Both files share the fresh fixture filesystem; link refuses an existing destination.
    await link(output, binary)
  } catch (error) { failures.push(error) }
  if (removable) {
    try { await rm(directory, { recursive: true }) }
    catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Codex fixture build and cleanup failed.')
}

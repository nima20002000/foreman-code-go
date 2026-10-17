import { spawn } from 'node:child_process'

export interface GitProcessOptions {
  cwd?: string
  signal: AbortSignal
  env?: Record<string, string>
  maximumFileBytes?: number
  lockFd?: number
  transferLockFd?: number
}
export interface GitProcessResult { code: number; stdout: string; stderr: string }

/** All Git children share the transfer's file limit and cache lock, including after an API process exits. */
export function runGitProcess(args: string[], options: GitProcessOptions,
  environment: NodeJS.ProcessEnv): Promise<GitProcessResult> {
  return new Promise(resolve => {
    const command = ['/bin/sh', '-c', 'umask 077 && exec git "$@"', 'git', ...args]
    const limited = options.maximumFileBytes !== undefined
    const executable = limited ? '/usr/bin/prlimit' : command.shift()!
    const childArgs = limited
      ? [`--fsize=${options.maximumFileBytes}:${options.maximumFileBytes}`, '--', ...command] : command
    const child = spawn(executable, childArgs, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe',
        ...(options.lockFd !== undefined ? [options.lockFd] : []),
        ...(options.transferLockFd !== undefined ? [options.transferLockFd] : [])],
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_NO_LAZY_FETCH: '1', ...options.env },
    })
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    let failed = false
    const stop = () => {
      failed = true
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.on('data', (chunk: Buffer) => {
        sizes[stream] += chunk.length
        if (sizes[stream] > 4 * 1024 * 1024) stop()
        else output[stream].push(chunk)
      })
    }
    child.once('error', () => { failed = true })
    const timer = setTimeout(stop, 15 * 60_000)
    options.signal.addEventListener('abort', stop, { once: true })
    if (options.signal.aborted) stop()
    child.once('close', code => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
      resolve({ code: failed || options.signal.aborted ? 1 : code ?? 1,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8') })
    })
  })
}

import type { ChildProcess } from 'node:child_process'

export function waitForChildReady(child: ChildProcess, ready: () => boolean, description: string,
  exitMessage: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.off('message', check)
      child.off('exit', exited)
      child.off('error', failed)
      if (error) reject(error)
      else resolve()
    }
    const exited = () => finish(new Error(exitMessage()))
    const failed = (error: Error) => finish(error)
    const check = () => {
      if (child.exitCode !== null || child.signalCode !== null) exited()
      else if (ready()) finish()
    }
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}.`)), 90_000)
    child.on('message', check)
    child.once('exit', exited)
    child.once('error', failed)
    check()
  })
}

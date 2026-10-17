import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'unreadable or missing'
    throw new Error(`Expected test report ${path} is ${reason}.`, { cause: error })
  }
}

/** Reports become visible only after their complete contents have been written. */
export function writeJsonReport(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Go supplies measured milliseconds directly; Vitest supplies wall-clock endpoints. */
export function reportDuration(result) {
  if (Object.hasOwn(result, 'duration')) return result.duration
  return result.endTime - result.startTime
}

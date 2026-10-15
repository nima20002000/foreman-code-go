/// <reference types="../../types/pino-roll.d.ts" />
import { readdir, readlink, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runtimeTimingChannel, type RuntimeTimingRecord } from './runtimeTiming.js'
import type { LogComponent } from './logComponent.js'
export type { LogComponent } from './logComponent.js'
import pino, { type Level, type Logger, type LevelWithSilent } from 'pino'
import { recordOperationalFailure } from './operationalFailures.js'
export { readOperationalFailures } from './operationalFailures.js'

// Secrets and model content never reach a log line, wherever they sit in a logged object.
const REDACTED_KEYS = ['authorization', 'cookie', 'set-cookie', 'token', 'accessToken', 'refreshToken', 'apiKey', 'api_key',
  'password', 'secret', 'credential', 'connectionString', 'prompt', 'initialPrompt', 'input', 'output', 'env', 'environment']
const REDACT_PATHS = [...REDACTED_KEYS, ...REDACTED_KEYS.map((key) => `*.${key}`), ...REDACTED_KEYS.map((key) => `*.*.${key}`),
  'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']

const LEVELS: readonly LevelWithSilent[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']
function levelFrom(env: NodeJS.ProcessEnv): LevelWithSilent {
  const wanted = env.LOG_LEVEL?.trim().toLowerCase()
  if (wanted && (LEVELS as readonly string[]).includes(wanted)) return wanted as LevelWithSilent
  // Unit tests stay quiet unless a test asks for output.
  return env.VITEST ? 'silent' : 'info'
}

const level = levelFrom(process.env)
/** Keep diagnostic identity and the bounded cause chain; child-process handles can be cyclic. */
export function serializeError(value: unknown, seen = new Set<unknown>(), depth = 0): Record<string, unknown> {
  if (depth >= 8 || seen.size >= 32 || seen.has(value)) return { message: 'Repeated or truncated error cause.' }
  if (!value || typeof value !== 'object') return { message: String(value) }
  seen.add(value)
  const error = value as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; cause?: unknown }
  return { type: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : 'Unknown error',
    ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: error.code } : {}),
    ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map(cause => serializeError(cause, seen, depth + 1)) } : {}),
    ...(error.cause !== undefined ? { cause: serializeError(error.cause, seen, depth + 1) } : {}) }
}
// Log backpressure must not block PostgreSQL replies on the API event loop.
const streams = pino.multistream([{
  level: level === 'silent' ? 'fatal' : level as Level,
  stream: pino.destination({ dest: 1, sync: false }),
}])

/** The one API logger. Everything else is a child of it. */
export const logger: Logger = pino({
  level,
  base: { service: 'graphql-api', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  serializers: { err: serializeError, error: serializeError },
}, streams)

export const componentLogger = (component: LogComponent): Logger => {
  const child = logger.child({ component })
  for (const level of ['warn', 'error'] as const) {
    const write = child[level].bind(child)
    child[level] = ((...args: unknown[]) => {
      const fields = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {}
      const operation = typeof fields.operation === 'string' ? fields.operation : `${component} background operation`
      const shouldWarn = recordOperationalFailure(component, operation, fields.err ?? fields.error, fields)
      if (level === 'error' || shouldWarn || typeof fields.operation !== 'string') Reflect.apply(write, child, args)
    }) as Logger['warn']
  }
  return child
}

if (logger.isLevelEnabled('debug')) {
  runtimeTimingChannel.subscribe((message) => {
    logger.debug({ diagnostic: 'runtime-timing', ...(message as RuntimeTimingRecord) }, 'workflow runtime timing')
  })
}

/** Where file logs go, or undefined when only stdout is wanted. LOG_FILE wins over LOG_DIR. */
export function logFilePath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.LOG_FILE?.trim()) return resolve(env.LOG_FILE.trim())
  if (env.LOG_DIR?.trim()) return join(resolve(env.LOG_DIR.trim()), 'api.log')
  return undefined
}

const positive = (value: string | undefined, fallback: number) => {
  const number = Number(value ?? fallback)
  if (Number.isSafeInteger(number) && number > 0) return number
  componentLogger('lifecycle').warn({ operation: 'read log retention configuration',
    err: Object.assign(new Error('Invalid provided log retention setting; using its documented default.'),
      { code: 'INVALID_LOG_CONFIG' }) }, 'Invalid log retention configuration')
  return fallback
}

/**
 * Deletes rotated files older than `days`, then all but the newest `count`. Only this
 * logger's own numbered and dated files are touched. The active destination stays,
 * counts toward the limit, and is never removed for age.
 */
export async function pruneLogFiles(file: string, count: number, days: number, now = Date.now()): Promise<string[]> {
  const directory = dirname(file)
  const base = basename(file).replace(/\.log$/, '')
  const target = await readlink(join(directory, 'current.log')).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EINVAL') return undefined
    throw error
  })
  const active = target === undefined ? undefined : resolve(directory, target)
  const own = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:\\d{4}-\\d{2}-\\d{2}\\.)?\\d+\\.log$`)
  const names = (await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      componentLogger('lifecycle').warn({ operation: 'read log directory', file: basename(file), err: error },
        'Could not read rotated logs')
    }
    return [] as string[]
  })).filter((name) => own.test(name))
  const files = (await Promise.all(names.map(async (name) => ({
    name,
    active: resolve(directory, name) === active,
    modified: (await stat(join(directory, name))).mtimeMs,
  })))).sort((a, b) => Number(b.active) - Number(a.active) || b.modified - a.modified)
  const expired = files.filter((item, index) => !item.active
    && (index >= count || now - item.modified > days * 86_400_000)).map((item) => item.name)
  await Promise.allSettled(expired.map((name) => unlink(join(directory, name)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    componentLogger('lifecycle').warn({ operation: 'remove rotated log', file: name, err: error },
      'Could not remove rotated log')
  })))
  return expired
}

/**
 * Adds a rotating file beside stdout: a new file daily or at LOG_MAX_SIZE (default 20m).
 * Retention: at most LOG_MAX_FILES files (default 14) and nothing older than
 * LOG_RETENTION_DAYS (default 14), enforced at startup and on every roll, across restarts.
 * Writes are synchronous for the same crash reason.
 */
export async function enableFileLogging(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = logFilePath(env)
  if (!file) return undefined
  const count = positive(env.LOG_MAX_FILES, 14)
  const days = positive(env.LOG_RETENTION_DAYS, 14)
  const { default: roll } = await import('pino-roll')
  // Daily names prevent a roll from reopening a numbered file from an earlier day.
  const stream = await roll({ file: file.replace(/\.log$/, ''), extension: '.log', frequency: 'daily',
    dateFormat: 'yyyy-MM-dd', size: env.LOG_MAX_SIZE ?? '20m', mkdir: true, symlink: true, sync: false })
  // pino.destination flushes stdout at exit; pino-roll needs the same final drain.
  process.once('exit', () => stream.flushSync())
  const pruned = await pruneLogFiles(file, count, days)
  let cleanup = Promise.resolve()
  // Reopen emits ready after the active symlink changes. Serialize retention across rolls.
  stream.on('ready', () => {
    cleanup = cleanup.then(async () => {
      await pruneLogFiles(file, count, days)
    }).catch((error: unknown) => {
      componentLogger('lifecycle').warn({ operation: 'prune rotated logs', file: basename(file), err: error },
        'Could not prune rotated logs')
    })
  })
  streams.add({ level: level === 'silent' ? 'fatal' : level as Level, stream })
  logger.info({ component: 'lifecycle', file: basename(file), maxFiles: count, retentionDays: days, prunedFiles: pruned.length }, 'file logging enabled')
  return file
}

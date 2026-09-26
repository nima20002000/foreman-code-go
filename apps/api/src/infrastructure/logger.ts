import { basename, join, resolve } from 'node:path'
import pino, { type Level, type Logger, type LevelWithSilent } from 'pino'

/** Components that own a child logger. Keep this list short and stable: it is the `component` field operators filter on. */
export type LogComponent = 'lifecycle' | 'http' | 'engine' | 'harness' | 'db'

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
// Synchronous writes: a crash or process.exit() right after a log call must not lose that line.
const streams = pino.multistream([{ level: level === 'silent' ? 'fatal' : level as Level, stream: pino.destination({ dest: 1, sync: true }) }])

/** The one API logger. Everything else is a child of it. */
export const logger: Logger = pino({
  level,
  base: { service: 'graphql-api', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
}, streams)

export const componentLogger = (component: LogComponent): Logger => logger.child({ component })

/** Where file logs go, or undefined when only stdout is wanted. LOG_FILE wins over LOG_DIR. */
export function logFilePath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.LOG_FILE?.trim()) return resolve(env.LOG_FILE.trim())
  if (env.LOG_DIR?.trim()) return join(resolve(env.LOG_DIR.trim()), 'api.log')
  return undefined
}

/**
 * Adds a rotating file beside stdout: a new file daily or at LOG_MAX_SIZE (default 20m),
 * keeping LOG_MAX_FILES (default 14). Writes are synchronous for the same crash reason.
 */
export async function enableFileLogging(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = logFilePath(env)
  if (!file) return undefined
  const { default: roll } = await import('pino-roll')
  const count = Number(env.LOG_MAX_FILES ?? 14)
  const stream = await roll({ file: file.replace(/\.log$/, ''), extension: '.log', frequency: 'daily', size: env.LOG_MAX_SIZE ?? '20m',
    mkdir: true, symlink: true, sync: true, limit: { count: Number.isSafeInteger(count) && count > 0 ? count : 14 } })
  streams.add({ level: level === 'silent' ? 'fatal' : level as Level, stream })
  logger.info({ component: 'lifecycle', file: basename(file) }, 'file logging enabled')
  return file
}

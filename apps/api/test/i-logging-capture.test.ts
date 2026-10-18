import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

// Terminal overlays this file into apps/api/test at the frozen TS commit.
// Every child has fresh state and exits naturally after the public logger drain.
const api = resolve(import.meta.dirname, '..')
const loggerURL = pathToFileURL(join(api, 'src/modules/diagnostics/logger.ts')).href
const loaderURL = import.meta.resolve('tsx')

async function capture(source: string): Promise<Record<string, any>[]> {
  const root = await mkdtemp(join(tmpdir(), 'foreman-i-logging-capture-'))
  try {
    for (const name of ['home', 'config', 'state', 'cache', 'tmp']) await mkdir(join(root, name))
    const script = join(root, 'capture.mts')
    await writeFile(script, `import { logger, flushLogsSync } from ${JSON.stringify(loggerURL)}\n${source}\nflushLogsSync()\n`)
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, ['--import', loaderURL, script], {
        cwd: root,
        env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
          XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
          TMPDIR: join(root, 'tmp'), LOG_LEVEL: 'trace' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', (part: Buffer) => { stdout += part.toString() })
      child.stderr.on('data', (part: Buffer) => { stderr += part.toString() })
      child.once('error', fail)
      child.once('close', code => done({ code, stdout, stderr }))
    })
    expect(outcome.code, outcome.stderr).toBe(0)
    expect(outcome.stderr).toBe('')
    return outcome.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('logging.stdout-nonfinite-structure', async () => {
  const [line] = await capture(`logger.info({ nan: NaN, positive: Infinity, negative: -Infinity,
    details: { safe: 'retained', value: Infinity, array: [NaN, 2] },
    err: { message: 'numeric code', code: -Infinity } }, 'nonfinite probe')`)
  expect(line).toMatchObject({ nan: null, positive: null, negative: null,
    details: { safe: 'retained', value: null, array: [null, 2] },
    err: { message: 'numeric code', code: null } })
})

it('logging.stdout-selective-clone-cycles', async () => {
  const [line, after] = await capture(`const value: any = { safe: 'retained', token: 'outside-source-paths' }
    value.self = value
    logger.info({ details: value }, 'circular probe')
    logger.info({ remained: value.token }, 'caller value')`)
  let current = line!.details
  for (let depth = 0; depth < 2; depth++) {
    expect(current).toMatchObject({ safe: 'retained', token: '[redacted]' })
    current = current.self
  }
  expect(current).toEqual({ safe: 'retained', token: 'outside-source-paths', self: '[Circular]' })
  expect(after!.remained).toBe('outside-source-paths')
})

it('logging.stdout-repeated-ordinary-values', async () => {
  const [line] = await capture(`const shared = { safe: 'retained' }
    const wide = Object.fromEntries(Array.from({ length: 105 }, (_, i) => ['key' + String(i).padStart(3, '0'), i]))
    let deep: any = 'leaf'
    for (let i = 0; i < 9; i++) deep = { next: deep }
    logger.info({ details: { left: shared, right: shared, wide, deep } }, 'ordinary probe')`)
  expect(line!.details.left).toEqual({ safe: 'retained' })
  expect(line!.details.right).toEqual({ safe: 'retained' })
  expect(Object.keys(line!.details.wide)).toHaveLength(105)
  let deep = line!.details.deep
  for (let i = 0; i < 9; i++) deep = deep.next
  expect(deep).toBe('leaf')
})

it('logging.stdout-circular-source-bounds', async () => {
  const lines = await capture(`const wide: any = Object.fromEntries(Array.from({ length: 105 }, (_, i) => ['key' + String(i).padStart(3, '0'), i]))
    wide.zzself = wide
    logger.info({ details: wide }, 'breadth')
    for (const length of [101, 102]) {
      const array: any[] = Array.from({ length }, (_, i) => i)
      array[length - 1] = array
      logger.info({ details: array }, 'array-' + length)
    }
    let deep: any = 'leaf'
    for (let i = 0; i < 8; i++) deep = { next: deep }
    const cyclic: any = { deep }; cyclic.self = cyclic
    logger.info({ details: cyclic }, 'depth')`)
  expect(Object.keys(lines[0]!.details)).toHaveLength(101)
  expect(lines[0]!.details['...']).toBe('6 items not stringified')
  expect(lines[0]!.details.key099).toBe(99)
  expect(lines[0]!.details).not.toHaveProperty('key100')
  expect(lines[1]!.details).toHaveLength(100)
  expect(lines[2]!.details).toHaveLength(101)
  expect(lines[2]!.details[100]).toBe('... 1 item not stringified')
  let deep = lines[3]!.details.deep
  for (let depth = 2; depth <= 5; depth++) deep = deep.next
  expect(deep).toBe('[Object]')
})

it('logging.stdout-javascript-number-errors', async () => {
  const lines = await capture(`for (const value of [NaN, Infinity, -Infinity, -0, 1e-6, 1e-7, 1e20, 1e21,
    JSON.parse('1e-6'), JSON.parse('-0')]) logger.error({ err: value }, 'primitive error')`)
  expect(lines.map(line => line.err.message)).toEqual(['NaN', 'Infinity', '-Infinity', '0',
    '0.000001', '1e-7', '100000000000000000000', '1e+21', '0.000001', '0'])
})

it('logging.stdout-utf16-errors-and-fields', async () => {
  const lines = await capture(`for (const value of ['', 'x', '\\ud800', '\\udfff', '\\ud83d\\ude00']) {
      logger.error({ err: value }, 'text error')
    }
    logger.info({ details: { text: '\\ud800', array: ['\\udfff', ''], object: {} } }, 'text fields')`)
  expect(lines.slice(0, 5).map(line => line.err.message)).toEqual(['', 'x', '\ud800', '\udfff', '\ud83d\ude00'])
  expect(lines[5]!.details).toEqual({ text: '\ud800', array: ['\udfff', ''], object: {} })
})

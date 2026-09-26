import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const api = resolve(import.meta.dirname, '..')
const temps: string[] = []
afterEach(async () => { await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** Runs a real Node process against the real logger modules, as the API process would. */
async function run(source: string, env: NodeJS.ProcessEnv = {}, signal?: NodeJS.Signals) {
  const dir = await mkdtemp(join(tmpdir(), 'api-log-script-')); temps.push(dir)
  const script = join(dir, 'main.mts')
  await writeFile(script, source)
  return new Promise<{ code: number | null; lines: Record<string, unknown>[] }>((done, fail) => {
    // Without VITEST the child logs like the real API process.
    const parent = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'VITEST'))
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: api, env: { ...parent, LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', signalled = false
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk
      if (signal && !signalled && out.includes('"ready"')) { signalled = true; child.kill(signal) }
    })
    child.on('error', fail)
    child.on('exit', (code) => done({ code, lines: out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>) }))
  })
}
const imports = `import { componentLogger, enableFileLogging } from '${join(api, 'src/infrastructure/logger.ts')}'
import { installProcessLifecycleLogging } from '${join(api, 'src/infrastructure/processLifecycle.ts')}'
const log = componentLogger('lifecycle'); installProcessLifecycleLogging(log)`

describe('API logging', () => {
  it('writes structured JSON with component, level and redacted secrets', async () => {
    const { code, lines } = await run(`${imports}
      componentLogger('http').info({ req: { headers: { authorization: 'Bearer s3cret' } }, token: 'tok', run: { prompt: 'private words' } }, 'hello')`)
    expect(code).toBe(0)
    const hello = lines.find((line) => line.msg === 'hello')!
    expect(hello).toMatchObject({ level: 'info', service: 'graphql-api', component: 'http', token: '[redacted]', run: { prompt: '[redacted]' } })
    expect(JSON.stringify(lines)).not.toMatch(/s3cret|private words|"tok"/)
    expect(lines.at(-1)).toMatchObject({ msg: 'process exiting', exitCode: 0 })
  })

  it.each([
    ['uncaught exception', `setTimeout(() => { throw new Error('boom') })`],
    ['unhandled rejection', `Promise.reject(new Error('boom'))`],
  ])('logs a fatal line before an %s ends the process', async (kind, crash) => {
    const { code, lines } = await run(`${imports}\n${crash}`)
    expect(code).toBe(1)
    const fatal = lines.find((line) => line.level === 'fatal')!
    expect(fatal).toMatchObject({ msg: kind, component: 'lifecycle', err: { message: 'boom' } })
    expect(lines.at(-1)).toMatchObject({ level: 'error', msg: 'process exiting', exitCode: 1 })
  })

  it('logs a shutdown signal and still lets the owner handle it', async () => {
    const { code, lines } = await run(`${imports}
      process.once('SIGTERM', () => { log.info('stopped'); process.exit(0) })
      log.info('ready'); setInterval(() => {}, 1000)`, {}, 'SIGTERM')
    expect(code).toBe(0)
    expect(lines.map((line) => line.msg)).toEqual(['ready', 'shutdown signal received', 'stopped', 'process exiting'])
  })

  it('also writes to a rotating file under LOG_DIR, including the fatal line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'api-logs-')); temps.push(dir)
    const { code } = await run(`${imports}\nawait enableFileLogging(process.env)\nthrow new Error('file boom')`, { LOG_DIR: dir })
    expect(code).toBe(1)
    const files = (await readdir(dir)).filter((name) => /^api\.\d+\.log$/.test(name))
    expect(files).toHaveLength(1)
    const written = await readFile(join(dir, files[0]!), 'utf8')
    expect(written).toContain('"msg":"file logging enabled"')
    expect(written).toContain('"level":"fatal"')
    expect(written).toContain('file boom')
    expect(written).toContain('"msg":"process exiting"')
  })
})

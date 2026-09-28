import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const commonResult = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' })
if (commonResult.status !== 0) throw new Error(commonResult.stderr || 'Cannot find Git common directory')
const common = commonResult.stdout.trim()
const activePath = join(common, 'graphql-heavy-jobs', 'active', 'owner.json')
const owner = () => { try { return JSON.parse(readFileSync(activePath, 'utf8')) } catch { return null } }

export default async function setup() {
  const inherited = owner()
  if (process.env.GRAPHQL_HEAVY_JOB_COMMON === common && process.env.GRAPHQL_HEAVY_JOB_TOKEN === inherited?.token) return
  const child = spawn(process.execPath, [join(root, 'scripts/heavy-job.mjs'), '--', process.execPath, join(root, 'scripts/heavy-job.mjs'), '__hold'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((resolveReady, reject) => {
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      for (;;) {
        const end = output.indexOf('\n')
        if (end < 0) break
        const line = output.slice(0, end)
        output = output.slice(end + 1)
        if (line.startsWith('[heavy-job] ')) process.stdout.write(`${line.slice(0, 300)}\n`)
        if (line.startsWith('[heavy-job] running ')) resolveReady()
      }
      if (output.length > 4096) output = output.slice(-4096)
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Heavy-job holder exited before admission (${code})`)))
  })
  const admitted = owner()
  if (!admitted?.token || !admitted.tempPath) {
    child.stdin.end()
    throw new Error('Heavy-job holder did not publish its owned slot')
  }
  const previous = Object.fromEntries(['GRAPHQL_HEAVY_JOB_COMMON', 'GRAPHQL_HEAVY_JOB_TOKEN', 'GRAPHQL_HEAVY_BASE_TMPDIR', 'TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    GRAPHQL_HEAVY_JOB_COMMON: common,
    GRAPHQL_HEAVY_JOB_TOKEN: admitted.token,
    GRAPHQL_HEAVY_BASE_TMPDIR: dirname(dirname(admitted.tempPath)),
    TMPDIR: admitted.tempPath,
    TMP: admitted.tempPath,
    TEMP: admitted.tempPath,
  })
  return async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const exited = child.exitCode !== null || child.signalCode !== null
    const exit = exited ? Promise.resolve() : new Promise((resolveExit) => child.once('exit', resolveExit))
    child.stdin.end()
    await exit
  }
}

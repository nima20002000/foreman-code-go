#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const { values } = parseArgs({ options: { harness: { type: 'string' }, binary: { type: 'string' },
  model: { type: 'string' } } })
if (!['codex', 'opencode'].includes(values.harness) || !values.binary) {
  throw new Error('Usage: qualify-harness --harness codex|opencode --binary /path/to/binary [--model provider/model]')
}
const resolveBinary = async (binary) => {
  const candidates = isAbsolute(binary) || binary.includes('/') ? [resolve(binary)]
    : (process.env.PATH ?? '').split(delimiter).map((part) => join(part, binary))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return realpath(candidate) } catch { /* Next PATH entry. */ }
  }
  throw new Error('Installed harness binary was not found.')
}
const binary = await resolveBinary(values.binary)
if (!(await stat(binary)).isFile()) throw new Error('Harness binary must be a regular file.')
const sha256 = async () => createHash('sha256').update(await readFile(binary)).digest('hex')
const before = await sha256()
const run = promisify(execFile)
const environment = { ...process.env }
for (const key of Object.keys(environment)) {
  if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_') || key.startsWith('GRAPHQL_APP_')
    || ['GRAPHQL_MCP_TOKEN', 'DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD'].includes(key)) delete environment[key]
}
const { stdout, stderr } = await run(binary, ['--version'], { timeout: 30_000, maxBuffer: 1024 * 1024, env: environment })
const reported = (stdout || stderr).trim()
const version = values.harness === 'codex' ? reported.replace(/^codex-cli\s+/, '') : reported
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Harness did not report a release version.')
const workDirectory = await mkdtemp(join(tmpdir(), `graphql-${values.harness}-qualification-`))
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { tsImport } = await import(requireApi.resolve('tsx/esm/api'))
const source = (name) => new URL(`../apps/api/src/modules/harnesses/qualification/${name}`, import.meta.url).href
const { QUALIFICATION_TARGET_PROFILE } = await tsImport(source('profiles.ts'), import.meta.url)
const { codexQualificationSuite } = await tsImport(source('suites/codex.ts'), import.meta.url)
const { opencodeQualificationSuite } = await tsImport(source('suites/opencode.ts'), import.meta.url)
const suite = values.harness === 'codex' ? codexQualificationSuite : opencodeQualificationSuite
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error('Harness qualification exceeded four minutes.')), 240_000)
try {
  const result = await suite.run({ binary, version, binarySha256: before,
    profile: QUALIFICATION_TARGET_PROFILE[values.harness], model: values.model ?? null,
    workDirectory, signal: controller.signal })
  const unchanged = before === await sha256()
  const checks = [...result.checks, { id: 'binary-unchanged', passed: unchanged,
    detail: unchanged ? null : 'Installed binary changed during qualification.' }]
  process.stdout.write(JSON.stringify({ harness: values.harness, version, binarySha256: before,
    profile: QUALIFICATION_TARGET_PROFILE[values.harness], suiteRevision: suite.revision,
    checks, evidence: result.evidence }) + '\n')
  if (checks.some((check) => !check.passed)) process.exitCode = 1
} finally {
  clearTimeout(timeout)
  await rm(workDirectory, { recursive: true, force: true })
}

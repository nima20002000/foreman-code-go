import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const source = '7c282ec9015d4f8c3b575c184a093cbde012197f'
const root = await mkdtemp(join(tmpdir(), 'foreman-node-event-'))
try {
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts/empty.test.mjs'), '// This toy file registers zero tests.\n')
  const original = pathToFileURL(join(process.cwd(), 'scripts/ci-node-test-reporter.mjs')).href
  const wrapper = join(root, 'observe.mjs')
  await writeFile(wrapper, `import report from ${JSON.stringify(original)}
export default async function* observedReport(events) {
  async function* observe() {
    for await (const event of events) {
      if (['test:pass', 'test:fail'].includes(event.type)) {
        console.error('[node-native-event] ' + JSON.stringify({ type: event.type,
          name: event.data.name, file: event.data.file, nesting: event.data.nesting,
          detailsType: event.data.details?.type }))
      }
      yield event
    }
  }
  yield* report(observe())
}
`)
  const env = { ...process.env, CI_REPOSITORY_ROOT: root }
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CI_PROGRESS_FILE']) delete env[key]
  let output = ''
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=' + wrapper,
      '--test-reporter-destination=' + join(root, 'report.json'), 'scripts/empty.test.mjs'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))
  console.log('[empty-file-observation] ' + JSON.stringify({ source, nodeVersion: process.version,
    exitCode, authoredTests: 0, nativeEvents: output.replaceAll(root, '<owned-toy>'),
    report, diagnosticOnly: true }))
} finally { await rm(root, { recursive: true, force: true }) }
